//! MINT guardrail vault: the PRD's "non-bypassable" hard caps, enforced by the chain.
//!
//! One vault per user. It holds the capital MINT's autonomous agent may trade and checks every
//! guardrail on-chain, so a leaked agent key or a bug in MINT's server cannot exceed them:
//!
//! - **Agent scope.** The agent key can only call `swap` (and `halt`). It can never withdraw;
//!   `withdraw` pays the owner and nobody else.
//! - **Hard capital cap.** A deposit is refused if the vault would be worth more than the cap.
//! - **Max trade size.** The oracle value of a swap's input is capped.
//! - **Max slippage.** `amount_out_min` must be within the slippage limit of the oracle price, so the
//!   agent cannot dump funds into a bad or manipulated pool.
//! - **Daily loss limit.** The vault's value is marked at the start of each 24h window; a swap that
//!   starts, or would end, below `mark × (1 − limit)` is refused.
//! - **Allowed assets / max per asset.** Only listed tokens can be on a swap path, and a swap cannot
//!   push any one non-base asset above its share of the cap.
//! - **Kill switch.** The owner or the agent can halt trading; only the owner can resume.
//!
//! Swaps go through a Soroswap-compatible router (Soroban contracts cannot place SDEX offers), and
//! prices come from a SEP-40 oracle quoted in the base token: MINT's own price feed on testnet,
//! Reflector on mainnet. The oracle is trusted. Whoever controls it can mis-value the vault.
#![no_std]

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    vec, Address, BytesN, ContractExecutable, Env, IntoVal, Map, Symbol, Vec,
};

// ─── External interfaces ────────────────────────────────────────────────────

/// SEP-40 asset identifier.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40 price record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[allow(dead_code)]
#[contractclient(name = "OracleClient")]
pub trait Sep40 {
    fn decimals(env: Env) -> u32;
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
}

/// The subset of the Soroswap router (and aggregator-compatible routers) the vault uses.
#[allow(dead_code)]
#[contractclient(name = "RouterClient")]
pub trait Router {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;
    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/// All amounts are in the base token's smallest unit (USDC stroops, 7 decimals).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Limits {
    /// Maximum vault value after a deposit.
    pub capital_cap: i128,
    /// Maximum value of a single swap's input.
    pub max_trade: i128,
    /// Maximum drop in vault value within a 24h window, in basis points.
    pub max_daily_loss_bps: u32,
    /// Maximum value of any one non-base asset, as basis points of `capital_cap`.
    pub max_asset_bps: u32,
    /// Maximum shortfall of `amount_out_min` against the oracle price, in basis points.
    pub max_slippage_bps: u32,
    /// Oracle prices older than this many seconds are refused.
    pub max_price_age: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    pub agent: Address,
    pub base: Address,
    pub router: Address,
    pub oracle: Address,
    pub limits: Limits,
    pub halted: bool,
}

/// Start of the current 24h loss window and the vault's value at that moment (net of later
/// deposits and withdrawals).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DayMark {
    pub start: u64,
    pub value: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    Halted = 2,
    InvalidLimits = 3,
    InvalidAmount = 4,
    TokenNotAllowed = 5,
    InvalidPath = 6,
    CapitalCapExceeded = 7,
    TradeTooLarge = 8,
    SlippageTooHigh = 9,
    DailyLossLimit = 10,
    AssetLimitExceeded = 11,
    PriceUnavailable = 12,
    PriceStale = 13,
    DecimalsMismatch = 14,
    TokenNotEmpty = 15,
    SwapShortfall = 16,
    Overflow = 17,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Owner,
    Agent,
    Base,
    Router,
    Oracle,
    Limits,
    Halted,
    /// Allowed non-base tokens and the oracle asset that prices each.
    Tokens,
    Day,
}

// ─── Events ─────────────────────────────────────────────────────────────────

#[contractevent(topics = ["deposited"])]
pub struct Deposited {
    #[topic]
    pub token: Address,
    pub amount: i128,
    pub value_after: i128,
}

#[contractevent(topics = ["withdrawn"])]
pub struct Withdrawn {
    #[topic]
    pub token: Address,
    pub amount: i128,
    pub to: Address,
}

#[contractevent(topics = ["swapped"])]
pub struct Swapped {
    #[topic]
    pub caller: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
    pub value_in: i128,
    pub value_after: i128,
}

#[contractevent(topics = ["halted"])]
pub struct HaltedEvent {
    pub by: Address,
}

#[contractevent(topics = ["resumed"])]
pub struct Resumed {}

#[contractevent(topics = ["limits_changed"])]
pub struct LimitsChanged {
    pub limits: Limits,
}

#[contractevent(topics = ["agent_changed"])]
pub struct AgentChanged {
    pub agent: Address,
}

#[contractevent(topics = ["token_allowed"])]
pub struct TokenAllowed {
    #[topic]
    pub token: Address,
    pub oracle_asset: Asset,
}

#[contractevent(topics = ["token_removed"])]
pub struct TokenRemoved {
    #[topic]
    pub token: Address,
}

#[contractevent(topics = ["venue_changed"])]
pub struct VenueChanged {
    pub router: Address,
    pub oracle: Address,
}

const DAY: u64 = 86_400;
const BPS: i128 = 10_000;
const MAX_TOKENS: u32 = 12;
const MAX_HOPS: u32 = 4;
// ~30 days of ledgers; instance storage is bumped on every call.
const TTL: u32 = 518_400;
const TTL_THRESHOLD: u32 = TTL / 2;

// ─── Contract ───────────────────────────────────────────────────────────────

#[contract]
pub struct GuardrailVault;

#[contractimpl]
impl GuardrailVault {
    pub fn __constructor(env: Env, owner: Address, agent: Address, base: Address, router: Address, oracle: Address, limits: Limits) {
        check_limits(&env, &limits);
        let s = env.storage().instance();
        s.set(&Key::Owner, &owner);
        s.set(&Key::Agent, &agent);
        s.set(&Key::Base, &base);
        s.set(&Key::Router, &router);
        s.set(&Key::Oracle, &oracle);
        s.set(&Key::Limits, &limits);
        s.set(&Key::Halted, &false);
        s.set(&Key::Tokens, &Map::<Address, Asset>::new(&env));
    }

    // ── Owner: funds ────────────────────────────────────────────────────

    /// Moves `amount` of an allowed token from the owner into the vault, within the capital cap.
    pub fn deposit(env: Env, token: Address, amount: i128) -> i128 {
        let owner = owner(&env);
        owner.require_auth();
        bump(&env);
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        require_allowed(&env, &token);

        // Mark the window before the deposit so the deposit itself is not counted as a gain.
        let mut day = current_day(&env);
        token::TokenClient::new(&env, &token).transfer(&owner, &env.current_contract_address(), &amount);

        let value_after = total_value(&env);
        if value_after > limits(&env).capital_cap {
            panic_with_error!(&env, Error::CapitalCapExceeded);
        }
        day.value = add(&env, day.value, value_of(&env, &token, amount));
        env.storage().instance().set(&Key::Day, &day);
        Deposited { token, amount, value_after }.publish(&env);
        value_after
    }

    /// Pays `amount` back to the owner. Works while halted and never depends on the oracle.
    pub fn withdraw(env: Env, token: Address, amount: i128) {
        let owner = owner(&env);
        owner.require_auth();
        bump(&env);
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        token::TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &owner, &amount);

        // Take the withdrawal out of the loss window too. If it can't be priced, leave the mark
        // high: that can only make the loss limit stricter.
        if let Some(mut day) = env.storage().instance().get::<_, DayMark>(&Key::Day) {
            if let Some(v) = try_value_of(&env, &token, amount) {
                day.value = (day.value - v).max(0);
                env.storage().instance().set(&Key::Day, &day);
            }
        }
        Withdrawn { token, amount, to: owner }.publish(&env);
    }

    // ── Agent or owner: trading ─────────────────────────────────────────

    /// Swaps an exact `amount_in` of `path[0]` for at least `amount_out_min` of the last token in
    /// `path`, through the configured router. Returns the amount received.
    pub fn swap(env: Env, caller: Address, amount_in: i128, amount_out_min: i128, path: Vec<Address>, deadline: u64) -> i128 {
        if caller != agent(&env) && caller != owner(&env) {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        caller.require_auth();
        bump(&env);
        if is_halted(&env) {
            panic_with_error!(&env, Error::Halted);
        }
        if amount_in <= 0 || amount_out_min <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let hops = path.len();
        if !(2..=MAX_HOPS).contains(&hops) {
            panic_with_error!(&env, Error::InvalidPath);
        }
        for token in path.iter() {
            require_allowed(&env, &token);
        }
        let token_in = path.get_unchecked(0);
        let token_out = path.get_unchecked(hops - 1);
        if token_in == token_out {
            panic_with_error!(&env, Error::InvalidPath);
        }
        let l = limits(&env);

        // Daily loss: refuse to trade if already below the floor.
        let day = current_day(&env);
        let floor = mul_div(&env, day.value, BPS - l.max_daily_loss_bps as i128, BPS);
        if total_value(&env) < floor {
            panic_with_error!(&env, Error::DailyLossLimit);
        }

        // Size and slippage against the oracle.
        let value_in = value_of(&env, &token_in, amount_in);
        if value_in > l.max_trade {
            panic_with_error!(&env, Error::TradeTooLarge);
        }
        let value_min_out = value_of(&env, &token_out, amount_out_min);
        if mul(&env, value_min_out, BPS) < mul(&env, value_in, BPS - l.max_slippage_bps as i128) {
            panic_with_error!(&env, Error::SlippageTooHigh);
        }

        // The router pulls `amount_in` from the vault into the first pair; authorize exactly that.
        let me = env.current_contract_address();
        let router = RouterClient::new(&env, &router(&env));
        let pair = router.router_pair_for(&token_in, &path.get_unchecked(1));
        let out = token::TokenClient::new(&env, &token_out);
        let before = out.balance(&me);
        // Must immediately precede the router call: it covers only the next contract invocation.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token_in.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (me.clone(), pair, amount_in).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        router.swap_exact_tokens_for_tokens(&amount_in, &amount_out_min, &path, &me, &deadline);
        let amount_out = out.balance(&me) - before;
        if amount_out < amount_out_min {
            panic_with_error!(&env, Error::SwapShortfall);
        }

        // Post-trade checks: still above the loss floor, and no single asset over its share.
        let value_after = total_value(&env);
        if value_after < floor {
            panic_with_error!(&env, Error::DailyLossLimit);
        }
        if token_out != base(&env) {
            let held = value_of(&env, &token_out, out.balance(&me));
            if mul(&env, held, BPS) > mul(&env, l.capital_cap, l.max_asset_bps as i128) {
                panic_with_error!(&env, Error::AssetLimitExceeded);
            }
        }

        Swapped { caller, token_in, token_out, amount_in, amount_out, value_in, value_after }.publish(&env);
        amount_out
    }

    /// Kill switch. The agent may halt itself; only the owner may resume.
    pub fn halt(env: Env, caller: Address) {
        if caller != agent(&env) && caller != owner(&env) {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        caller.require_auth();
        env.storage().instance().set(&Key::Halted, &true);
        bump(&env);
        HaltedEvent { by: caller }.publish(&env);
    }

    // ── Owner: configuration ────────────────────────────────────────────

    pub fn resume(env: Env) {
        owner(&env).require_auth();
        env.storage().instance().set(&Key::Halted, &false);
        bump(&env);
        Resumed {}.publish(&env);
    }

    pub fn set_limits(env: Env, limits: Limits) {
        owner(&env).require_auth();
        check_limits(&env, &limits);
        env.storage().instance().set(&Key::Limits, &limits);
        bump(&env);
        LimitsChanged { limits }.publish(&env);
    }

    pub fn set_agent(env: Env, agent: Address) {
        owner(&env).require_auth();
        env.storage().instance().set(&Key::Agent, &agent);
        bump(&env);
        AgentChanged { agent }.publish(&env);
    }

    pub fn set_venue(env: Env, router: Address, oracle: Address) {
        owner(&env).require_auth();
        env.storage().instance().set(&Key::Router, &router);
        env.storage().instance().set(&Key::Oracle, &oracle);
        bump(&env);
        VenueChanged { router, oracle }.publish(&env);
    }

    /// Adds (or re-maps) a tradable token and the oracle asset that prices it.
    pub fn allow_token(env: Env, token: Address, oracle_asset: Asset) {
        owner(&env).require_auth();
        let base = base(&env);
        if token == base {
            return;
        }
        let decimals = token::TokenClient::new(&env, &token).decimals();
        if decimals != token::TokenClient::new(&env, &base).decimals() {
            panic_with_error!(&env, Error::DecimalsMismatch);
        }
        let mut tokens = tokens(&env);
        if !tokens.contains_key(token.clone()) && tokens.len() >= MAX_TOKENS {
            panic_with_error!(&env, Error::InvalidLimits);
        }
        tokens.set(token.clone(), oracle_asset.clone());
        env.storage().instance().set(&Key::Tokens, &tokens);
        bump(&env);
        TokenAllowed { token, oracle_asset }.publish(&env);
    }

    /// Delists a token. It must be empty, or the vault would stop counting value it still holds.
    pub fn remove_token(env: Env, token: Address) {
        owner(&env).require_auth();
        if token::TokenClient::new(&env, &token).balance(&env.current_contract_address()) != 0 {
            panic_with_error!(&env, Error::TokenNotEmpty);
        }
        let mut tokens = tokens(&env);
        tokens.remove(token.clone());
        env.storage().instance().set(&Key::Tokens, &tokens);
        bump(&env);
        TokenRemoved { token }.publish(&env);
    }

    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        owner(&env).require_auth();
        env.deployer().update_current_contract(ContractExecutable::Wasm(wasm_hash));
    }

    // ── Views ───────────────────────────────────────────────────────────

    pub fn config(env: Env) -> Config {
        Config {
            owner: owner(&env),
            agent: agent(&env),
            base: base(&env),
            router: router(&env),
            oracle: oracle(&env),
            limits: limits(&env),
            halted: is_halted(&env),
        }
    }

    pub fn tokens(env: Env) -> Map<Address, Asset> {
        tokens(&env)
    }

    /// Total value in base-token units at current oracle prices.
    pub fn value(env: Env) -> i128 {
        total_value(&env)
    }

    pub fn day(env: Env) -> Option<DayMark> {
        env.storage().instance().get(&Key::Day)
    }
}

// ─── Internals ──────────────────────────────────────────────────────────────

fn get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: Key) -> V {
    env.storage().instance().get(&key).unwrap()
}
fn owner(env: &Env) -> Address {
    get(env, Key::Owner)
}
fn agent(env: &Env) -> Address {
    get(env, Key::Agent)
}
fn base(env: &Env) -> Address {
    get(env, Key::Base)
}
fn router(env: &Env) -> Address {
    get(env, Key::Router)
}
fn oracle(env: &Env) -> Address {
    get(env, Key::Oracle)
}
fn limits(env: &Env) -> Limits {
    get(env, Key::Limits)
}
fn tokens(env: &Env) -> Map<Address, Asset> {
    get(env, Key::Tokens)
}
fn is_halted(env: &Env) -> bool {
    get(env, Key::Halted)
}
fn bump(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL);
}

fn check_limits(env: &Env, l: &Limits) {
    let bps_ok = |b: u32| b <= 10_000;
    if l.capital_cap <= 0
        || l.max_trade <= 0
        || l.max_price_age == 0
        || !bps_ok(l.max_daily_loss_bps)
        || !bps_ok(l.max_asset_bps)
        || !bps_ok(l.max_slippage_bps)
    {
        panic_with_error!(env, Error::InvalidLimits);
    }
}

fn require_allowed(env: &Env, token: &Address) {
    if *token != base(env) && !tokens(env).contains_key(token.clone()) {
        panic_with_error!(env, Error::TokenNotAllowed);
    }
}

/// The current loss window, starting a new one (marked at the current value) once 24h have passed.
fn current_day(env: &Env) -> DayMark {
    let now = env.ledger().timestamp();
    match env.storage().instance().get::<_, DayMark>(&Key::Day) {
        Some(d) if now < d.start + DAY => d,
        _ => {
            let d = DayMark { start: now, value: total_value(env) };
            env.storage().instance().set(&Key::Day, &d);
            d
        }
    }
}

fn total_value(env: &Env) -> i128 {
    let me = env.current_contract_address();
    let mut total = token::TokenClient::new(env, &base(env)).balance(&me);
    for (token, _) in tokens(env).iter() {
        let balance = token::TokenClient::new(env, &token).balance(&me);
        if balance != 0 {
            total = add(env, total, value_of(env, &token, balance));
        }
    }
    total
}

/// Value of `amount` of `token` in base units. Panics if the price is missing or stale.
fn value_of(env: &Env, token: &Address, amount: i128) -> i128 {
    match price_of(env, token) {
        Ok(None) => amount,
        Ok(Some((price, decimals))) => mul_div(env, amount, price, pow10(env, decimals)),
        Err(e) => panic_with_error!(env, e),
    }
}

fn try_value_of(env: &Env, token: &Address, amount: i128) -> Option<i128> {
    match price_of(env, token) {
        Ok(None) => Some(amount),
        Ok(Some((price, decimals))) => amount.checked_mul(price).map(|v| v / 10i128.pow(decimals.min(38))),
        Err(_) => None,
    }
}

/// `Ok(None)` for the base token (worth exactly itself), else the oracle price and its decimals.
fn price_of(env: &Env, token: &Address) -> Result<Option<(i128, u32)>, Error> {
    if *token == base(env) {
        return Ok(None);
    }
    let asset = tokens(env).get(token.clone()).ok_or(Error::TokenNotAllowed)?;
    let oracle = OracleClient::new(env, &oracle(env));
    let p = oracle.lastprice(&asset).ok_or(Error::PriceUnavailable)?;
    if p.price <= 0 {
        return Err(Error::PriceUnavailable);
    }
    if env.ledger().timestamp() > p.timestamp + limits(env).max_price_age {
        return Err(Error::PriceStale);
    }
    Ok(Some((p.price, oracle.decimals())))
}

fn pow10(env: &Env, decimals: u32) -> i128 {
    10i128.checked_pow(decimals).unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}
fn mul(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_mul(b).unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}
fn add(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_add(b).unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}
fn mul_div(env: &Env, a: i128, b: i128, d: i128) -> i128 {
    mul(env, a, b) / d
}

#[cfg(test)]
mod test;
