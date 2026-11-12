extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal,
};

const U: i128 = 10_000_000; // one unit at 7 decimals
const ORACLE_DECIMALS: u32 = 14;
const P: i128 = 100_000_000_000_000; // 1.0 at 14 decimals

// ─── Mocks ──────────────────────────────────────────────────────────────────

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set(env: Env, asset: Asset, price: i128) {
        let data = PriceData { price, timestamp: env.ledger().timestamp() };
        env.storage().instance().set(&asset, &data);
    }
    pub fn decimals(_env: Env) -> u32 {
        ORACLE_DECIMALS
    }
    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        env.storage().instance().get(&asset)
    }
}

/// Behaves like Soroswap's router for a single pair living at the router's own address: it
/// requires `to`'s auth, pulls `amount_in` from `to`, and pays out at a fixed rate from inventory.
#[contract]
pub struct MockRouter;

#[contractimpl]
impl MockRouter {
    /// Output per 1 unit of input, scaled by 1e7.
    pub fn set_rate(env: Env, rate: i128) {
        env.storage().instance().set(&symbol_short!("rate"), &rate);
    }
    pub fn router_pair_for(env: Env, _a: Address, _b: Address) -> Address {
        env.current_contract_address()
    }
    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();
        let rate: i128 = env.storage().instance().get(&symbol_short!("rate")).unwrap();
        let out = amount_in * rate / U;
        assert!(out >= amount_out_min, "insufficient output");
        let me = env.current_contract_address();
        TokenClient::new(&env, &path.get_unchecked(0)).transfer(&to, &me, &amount_in);
        TokenClient::new(&env, &path.get_unchecked(path.len() - 1)).transfer(&me, &to, &out);
        vec![&env, amount_in, out]
    }
}

// ─── Fixture ────────────────────────────────────────────────────────────────

struct T {
    env: Env,
    vault: GuardrailVaultClient<'static>,
    owner: Address,
    agent: Address,
    usdc: TokenClient<'static>,
    btc: TokenClient<'static>,
    oracle: MockOracleClient<'static>,
    router: MockRouterClient<'static>,
}

fn limits() -> Limits {
    Limits {
        capital_cap: 500 * U,
        max_trade: 50 * U,
        max_daily_loss_bps: 500, // 5%
        max_asset_bps: 4_000,    // 40% of the cap per asset
        max_slippage_bps: 100,   // 1%
        max_price_age: 600,
    }
}

fn token(env: &Env) -> (TokenClient<'static>, StellarAssetClient<'static>) {
    let sac = env.register_stellar_asset_contract_v2(Address::generate(env));
    (TokenClient::new(env, &sac.address()), StellarAssetClient::new(env, &sac.address()))
}

fn setup() -> T {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let owner = Address::generate(&env);
    let agent = Address::generate(&env);
    let (usdc, usdc_admin) = token(&env);
    let (btc, btc_admin) = token(&env);

    let oracle = MockOracleClient::new(&env, &env.register(MockOracle, ()));
    let router = MockRouterClient::new(&env, &env.register(MockRouter, ()));
    let vault_id = env.register(
        GuardrailVault,
        (owner.clone(), agent.clone(), usdc.address.clone(), router.address.clone(), oracle.address.clone(), limits()),
    );
    let vault = GuardrailVaultClient::new(&env, &vault_id);

    // BTC at 100 USDC; the router quotes the oracle price exactly.
    let btc_asset = Asset::Other(symbol_short!("BTC"));
    oracle.set(&btc_asset, &(100 * P));
    router.set_rate(&(U / 100));
    vault.allow_token(&btc.address, &btc_asset);

    usdc_admin.mint(&owner, &(1_000 * U));
    usdc_admin.mint(&router.address, &(10_000 * U));
    btc_admin.mint(&router.address, &(1_000 * U));
    vault.deposit(&usdc.address, &(200 * U));

    T { env, vault, owner, agent, usdc, btc, oracle, router }
}

fn path(t: &T, from: &TokenClient, to: &TokenClient) -> Vec<Address> {
    vec![&t.env, from.address.clone(), to.address.clone()]
}

fn deadline(t: &T) -> u64 {
    t.env.ledger().timestamp() + 60
}

// ─── Funds ──────────────────────────────────────────────────────────────────

#[test]
fn deposit_respects_capital_cap() {
    let t = setup();
    assert_eq!(t.vault.value(), 200 * U);
    t.vault.deposit(&t.usdc.address, &(300 * U));
    assert_eq!(t.vault.value(), 500 * U);
    assert_eq!(t.vault.try_deposit(&t.usdc.address, &1).err(), Some(Ok(soroban_sdk::Error::from(Error::CapitalCapExceeded))));
}

#[test]
fn withdraw_only_pays_owner_and_works_when_halted() {
    let t = setup();
    t.vault.halt(&t.agent);
    t.vault.withdraw(&t.usdc.address, &(50 * U));
    assert_eq!(t.usdc.balance(&t.owner), 850 * U);
    assert_eq!(t.vault.value(), 150 * U);
    // The withdrawal also lowers the loss mark, so it doesn't read as a trading loss.
    assert_eq!(t.vault.day().unwrap().value, 150 * U);
}

#[test]
fn agent_cannot_withdraw() {
    let t = setup();
    t.env.mock_auths(&[MockAuth {
        address: &t.agent,
        invoke: &MockAuthInvoke {
            contract: &t.vault.address,
            fn_name: "withdraw",
            args: (t.usdc.address.clone(), 10 * U).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(t.vault.try_withdraw(&t.usdc.address, &(10 * U)).is_err());
    assert_eq!(t.vault.value(), 200 * U);
}

#[test]
fn rejects_tokens_not_on_the_list() {
    let t = setup();
    let (eth, eth_admin) = token(&t.env);
    eth_admin.mint(&t.owner, &U);
    assert_eq!(t.vault.try_deposit(&eth.address, &U).err(), Some(Ok(soroban_sdk::Error::from(Error::TokenNotAllowed))));
    let p = path(&t, &t.usdc, &eth);
    assert_eq!(
        t.vault.try_swap(&t.agent, &U, &U, &p, &deadline(&t)).err(),
        Some(Ok(soroban_sdk::Error::from(Error::TokenNotAllowed)))
    );
}

// ─── Swaps ──────────────────────────────────────────────────────────────────

#[test]
fn agent_swap_with_real_auth_tree() {
    let t = setup();
    let p = path(&t, &t.usdc, &t.btc);
    let (amount_in, min_out, dl) = (40 * U, 3_960_000i128, deadline(&t)); // 0.396 BTC = 1% under oracle

    // Only the agent's signature on `swap` is provided. The vault's own authorization of the
    // router's token pull must come from `authorize_as_current_contract`.
    t.env.mock_auths(&[MockAuth {
        address: &t.agent,
        invoke: &MockAuthInvoke {
            contract: &t.vault.address,
            fn_name: "swap",
            args: (t.agent.clone(), amount_in, min_out, p.clone(), dl).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    let out = t.vault.swap(&t.agent, &amount_in, &min_out, &p, &dl);
    assert_eq!(out, 4_000_000); // 0.4 BTC
    assert_eq!(t.btc.balance(&t.vault.address), 4_000_000);
    assert_eq!(t.usdc.balance(&t.vault.address), 160 * U);
    assert_eq!(t.vault.value(), 200 * U);
}

#[test]
fn strangers_cannot_swap() {
    let t = setup();
    let stranger = Address::generate(&t.env);
    let p = path(&t, &t.usdc, &t.btc);
    assert_eq!(
        t.vault.try_swap(&stranger, &U, &1, &p, &deadline(&t)).err(),
        Some(Ok(soroban_sdk::Error::from(Error::NotAuthorized)))
    );
}

#[test]
fn caps_trade_size() {
    let t = setup();
    let p = path(&t, &t.usdc, &t.btc);
    assert_eq!(
        t.vault.try_swap(&t.agent, &(51 * U), &(51 * U / 100), &p, &deadline(&t)).err(),
        Some(Ok(soroban_sdk::Error::from(Error::TradeTooLarge)))
    );
}

#[test]
fn refuses_loose_min_out() {
    let t = setup();
    let p = path(&t, &t.usdc, &t.btc);
    // 0.39 BTC for 40 USDC is 2.5% under the oracle; the limit is 1%.
    assert_eq!(
        t.vault.try_swap(&t.agent, &(40 * U), &3_900_000, &p, &deadline(&t)).err(),
        Some(Ok(soroban_sdk::Error::from(Error::SlippageTooHigh)))
    );
}

#[test]
fn per_asset_limit() {
    let t = setup();
    let p = path(&t, &t.usdc, &t.btc);
    // 40% of the 500 cap = 200 USDC of BTC. Four 50-USDC buys reach it, a fifth crosses it.
    t.vault.deposit(&t.usdc.address, &(100 * U));
    for _ in 0..4 {
        t.vault.swap(&t.agent, &(50 * U), &(U / 2), &p, &deadline(&t));
    }
    assert_eq!(
        t.vault.try_swap(&t.agent, &(10 * U), &(U / 10), &p, &deadline(&t)).err(),
        Some(Ok(soroban_sdk::Error::from(Error::AssetLimitExceeded)))
    );
}

#[test]
fn daily_loss_limit_blocks_then_resets() {
    let t = setup();
    let p = path(&t, &t.usdc, &t.btc);
    t.vault.swap(&t.agent, &(50 * U), &(U / 2), &p, &deadline(&t)); // 0.5 BTC, value 200

    // BTC falls 30%: vault 150 + 35 = 185, 7.5% below the 200 mark (limit 5%).
    t.oracle.set(&Asset::Other(symbol_short!("BTC")), &(70 * P));
    let back = path(&t, &t.btc, &t.usdc);
    t.router.set_rate(&(70 * U));
    assert_eq!(
        t.vault.try_swap(&t.agent, &(U / 10), &(7 * U * 99 / 100), &back, &deadline(&t)).err(),
        Some(Ok(soroban_sdk::Error::from(Error::DailyLossLimit)))
    );

    // A day later the window re-marks at the current value and trading resumes.
    t.env.ledger().set_timestamp(t.env.ledger().timestamp() + DAY);
    t.oracle.set(&Asset::Other(symbol_short!("BTC")), &(70 * P));
    t.vault.swap(&t.agent, &(U / 10), &(7 * U * 99 / 100), &back, &deadline(&t));
    assert_eq!(t.vault.day().unwrap().value, 185 * U);
}

#[test]
fn a_trade_that_would_cross_the_floor_is_reverted() {
    let t = setup();
    let p = path(&t, &t.usdc, &t.btc);
    t.vault.swap(&t.agent, &(50 * U), &(U / 2), &p, &deadline(&t)); // 0.5 BTC; mark 200, floor 190

    // BTC drifts to 80.9: vault = 150 + 40.45 = 190.45, just above the floor.
    t.oracle.set(&Asset::Other(symbol_short!("BTC")), &(809 * P / 10));
    assert_eq!(t.vault.value(), 190_450_0000);

    // A 50-USDC buy that fills just inside the 1% slippage limit loses ~0.4997, ending at ~189.95.
    t.router.set_rate(&122_374);
    let min_out = 6_118_700;
    assert_eq!(
        t.vault.try_swap(&t.agent, &(50 * U), &min_out, &p, &deadline(&t)).err(),
        Some(Ok(soroban_sdk::Error::from(Error::DailyLossLimit)))
    );
    assert_eq!(t.vault.value(), 190_450_0000);

    // A smaller buy with the same fill stays above the floor and goes through.
    t.vault.swap(&t.agent, &(10 * U), &(min_out / 5), &p, &deadline(&t));
}

#[test]
fn stale_or_missing_prices_block_trading() {
    let t = setup();
    let p = path(&t, &t.usdc, &t.btc);
    t.env.ledger().set_timestamp(t.env.ledger().timestamp() + 601);
    assert_eq!(
        t.vault.try_swap(&t.agent, &U, &(U / 100), &p, &deadline(&t)).err(),
        Some(Ok(soroban_sdk::Error::from(Error::PriceStale)))
    );
}

#[test]
fn kill_switch() {
    let t = setup();
    let p = path(&t, &t.usdc, &t.btc);
    t.vault.halt(&t.agent);
    assert!(t.vault.config().halted);
    assert_eq!(t.vault.try_swap(&t.agent, &U, &(U / 100), &p, &deadline(&t)).err(), Some(Ok(soroban_sdk::Error::from(Error::Halted))));

    // The agent cannot resume.
    t.env.mock_auths(&[MockAuth {
        address: &t.agent,
        invoke: &MockAuthInvoke { contract: &t.vault.address, fn_name: "resume", args: ().into_val(&t.env), sub_invokes: &[] },
    }]);
    assert!(t.vault.try_resume().is_err());

    t.env.mock_all_auths();
    t.vault.resume();
    t.vault.swap(&t.agent, &U, &(U / 100), &p, &deadline(&t));
}

#[test]
fn invalid_paths() {
    let t = setup();
    let same = vec![&t.env, t.usdc.address.clone(), t.usdc.address.clone()];
    let short = vec![&t.env, t.usdc.address.clone()];
    assert_eq!(t.vault.try_swap(&t.agent, &U, &U, &same, &deadline(&t)).err(), Some(Ok(soroban_sdk::Error::from(Error::InvalidPath))));
    assert_eq!(t.vault.try_swap(&t.agent, &U, &U, &short, &deadline(&t)).err(), Some(Ok(soroban_sdk::Error::from(Error::InvalidPath))));
}

// ─── Configuration ─────────────────────────────────────────────────────────

#[test]
fn owner_config_and_validation() {
    let t = setup();
    let mut l = limits();
    l.max_daily_loss_bps = 10_001;
    assert_eq!(t.vault.try_set_limits(&l).err(), Some(Ok(soroban_sdk::Error::from(Error::InvalidLimits))));
    l.max_daily_loss_bps = 300;
    t.vault.set_limits(&l);
    assert_eq!(t.vault.config().limits.max_daily_loss_bps, 300);

    let new_agent = Address::generate(&t.env);
    t.vault.set_agent(&new_agent);
    assert_eq!(t.vault.config().agent, new_agent);

    // Can't delist a token the vault still holds.
    let p = path(&t, &t.usdc, &t.btc);
    t.vault.swap(&t.owner, &(10 * U), &(U / 10), &p, &deadline(&t));
    assert_eq!(t.vault.try_remove_token(&t.btc.address).err(), Some(Ok(soroban_sdk::Error::from(Error::TokenNotEmpty))));
    t.vault.withdraw(&t.btc.address, &(U / 10));
    t.vault.remove_token(&t.btc.address);
    assert_eq!(t.vault.tokens().len(), 0);
}
