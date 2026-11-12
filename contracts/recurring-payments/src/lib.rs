//! MINT recurring payments (PRD §4.4 "Scheduled & Recurring Payments").
//!
//! Pull-payment schedules over any SEP-41 token (USDC's Stellar Asset Contract in MINT):
//!
//! 1. The payer `approve`s this contract on the token for what the schedules may pull. The token's
//!    `approve` *replaces* the previous allowance, so the app keeps it at the sum of every active
//!    schedule's remaining payments for that payer and token, and renews it before it expires.
//! 2. The payer signs `create`, fixing recipient, amount, interval and number of payments.
//! 3. Anyone (MINT's worker, as keeper) calls `execute` once a payment is due. The contract pays at
//!    most once per interval: a keeper that was down does not trigger back-to-back catch-up charges,
//!    missed periods are skipped and do not count against the schedule.
//!
//! Funds never leave the payer's wallet until a payment is due, and the payer or the recipient can
//! cancel at any time.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token, Address, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    InvalidAmount = 2,
    InvalidInterval = 3,
    InvalidCount = 4,
    NotDue = 5,
    NotAuthorized = 6,
    SamePayerAndRecipient = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Schedule {
    pub payer: Address,
    pub recipient: Address,
    pub token: Address,
    /// Per payment, in the token's smallest unit.
    pub amount: i128,
    /// Seconds between payments.
    pub interval: u64,
    /// Ledger timestamp from which the next payment may be pulled.
    pub next_due: u64,
    /// Payments left, including the next one.
    pub remaining: u32,
    pub paid: u32,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    NextId,
    Schedule(u64),
}

#[contractevent(topics = ["schedule_created"])]
pub struct ScheduleCreated {
    #[topic]
    pub id: u64,
    #[topic]
    pub payer: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub interval: u64,
    pub first_due: u64,
    pub count: u32,
}

#[contractevent(topics = ["payment_executed"])]
pub struct PaymentExecuted {
    #[topic]
    pub id: u64,
    #[topic]
    pub payer: Address,
    pub recipient: Address,
    pub amount: i128,
    pub remaining: u32,
    pub next_due: u64,
}

#[contractevent(topics = ["schedule_cancelled"])]
pub struct ScheduleCancelled {
    #[topic]
    pub id: u64,
    pub by: Address,
}

/// One hour. Shorter intervals would let a keeper drain an allowance quickly by mistake.
pub const MIN_INTERVAL: u64 = 3_600;
/// Ten years of monthly payments.
pub const MAX_COUNT: u32 = 120;
// ~30 days of ledgers; bumped on every touch so active schedules never archive.
const TTL: u32 = 518_400;
const TTL_THRESHOLD: u32 = TTL / 2;

#[contract]
pub struct RecurringPayments;

#[contractimpl]
impl RecurringPayments {
    /// Creates a schedule and returns its id. `first_due` may be now (pay immediately) or later.
    pub fn create(
        env: Env,
        payer: Address,
        recipient: Address,
        token: Address,
        amount: i128,
        interval: u64,
        first_due: u64,
        count: u32,
    ) -> u64 {
        payer.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if interval < MIN_INTERVAL {
            panic_with_error!(&env, Error::InvalidInterval);
        }
        if count == 0 || count > MAX_COUNT {
            panic_with_error!(&env, Error::InvalidCount);
        }
        if payer == recipient {
            panic_with_error!(&env, Error::SamePayerAndRecipient);
        }

        let instance = env.storage().instance();
        let id: u64 = instance.get(&Key::NextId).unwrap_or(0);
        instance.set(&Key::NextId, &(id + 1));
        instance.extend_ttl(TTL_THRESHOLD, TTL);

        let schedule = Schedule {
            payer: payer.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            amount,
            interval,
            next_due: first_due,
            remaining: count,
            paid: 0,
        };
        save(&env, id, &schedule);
        ScheduleCreated { id, payer, recipient, token, amount, interval, first_due, count }.publish(&env);
        id
    }

    /// Pulls one due payment. Callable by anyone; the schedule alone decides what moves.
    pub fn execute(env: Env, id: u64) -> Schedule {
        let mut s = load(&env, id);
        let now = env.ledger().timestamp();
        if now < s.next_due {
            panic_with_error!(&env, Error::NotDue);
        }

        token::TokenClient::new(&env, &s.token).transfer_from(
            &env.current_contract_address(),
            &s.payer,
            &s.recipient,
            &s.amount,
        );

        s.paid += 1;
        s.remaining -= 1;
        // Next slot strictly after now: missed periods are skipped, never charged twice.
        let behind = (now - s.next_due) / s.interval;
        s.next_due += (behind + 1) * s.interval;

        PaymentExecuted {
            id,
            payer: s.payer.clone(),
            recipient: s.recipient.clone(),
            amount: s.amount,
            remaining: s.remaining,
            next_due: s.next_due,
        }
        .publish(&env);

        if s.remaining == 0 {
            env.storage().persistent().remove(&Key::Schedule(id));
        } else {
            save(&env, id, &s);
        }
        s
    }

    /// Stops a schedule. Either party may cancel.
    pub fn cancel(env: Env, id: u64, by: Address) {
        let s = load(&env, id);
        if by != s.payer && by != s.recipient {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        by.require_auth();
        env.storage().persistent().remove(&Key::Schedule(id));
        ScheduleCancelled { id, by }.publish(&env);
    }

    pub fn get(env: Env, id: u64) -> Option<Schedule> {
        env.storage().persistent().get(&Key::Schedule(id))
    }

    /// Whether `execute(id)` would currently be accepted on timing (allowance not checked).
    pub fn is_due(env: Env, id: u64) -> bool {
        Self::get(env.clone(), id).is_some_and(|s| env.ledger().timestamp() >= s.next_due)
    }

    /// Tokens the schedule may still pull; the app sums these to size the allowance.
    pub fn outstanding(env: Env, id: u64) -> i128 {
        Self::get(env, id).map_or(0, |s| s.amount * s.remaining as i128)
    }
}

fn load(env: &Env, id: u64) -> Schedule {
    let key = Key::Schedule(id);
    match env.storage().persistent().get(&key) {
        Some(s) => {
            env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL);
            s
        }
        None => panic_with_error!(env, Error::NotFound),
    }
}

fn save(env: &Env, id: u64, s: &Schedule) {
    let key = Key::Schedule(id);
    env.storage().persistent().set(&key, s);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL);
}

#[cfg(test)]
mod test;
