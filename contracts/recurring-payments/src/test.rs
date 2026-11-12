extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

const DAY: u64 = 86_400;
const MONTH: u64 = 30 * DAY;
const USDC: i128 = 10_000_000; // 7 decimals

struct Setup {
    env: Env,
    rp: RecurringPaymentsClient<'static>,
    usdc: TokenClient<'static>,
    payer: Address,
    recipient: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);
    env.ledger().set_sequence_number(100);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let payer = Address::generate(&env);
    let recipient = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&payer, &(1_000 * USDC));

    let id = env.register(RecurringPayments, ());
    let rp = RecurringPaymentsClient::new(&env, &id);
    let usdc = TokenClient::new(&env, &sac.address());
    // Allowance for the whole schedule, as the app would set it.
    usdc.approve(&payer, &id, &(300 * USDC), &10_000);
    Setup { env, rp, usdc, payer, recipient }
}

#[test]
fn pays_each_period_then_finishes() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let id = t.rp.create(&t.payer, &t.recipient, &t.usdc.address, &(25 * USDC), &MONTH, &now, &3);
    assert!(t.rp.is_due(&id));
    assert_eq!(t.rp.outstanding(&id), 75 * USDC);

    t.rp.execute(&id);
    assert_eq!(t.usdc.balance(&t.recipient), 25 * USDC);
    assert!(!t.rp.is_due(&id));
    // Not due again until a month has passed.
    assert_eq!(t.rp.try_execute(&id).err(), Some(Ok(soroban_sdk::Error::from(Error::NotDue))));

    t.env.ledger().set_timestamp(now + MONTH);
    t.rp.execute(&id);
    t.env.ledger().set_timestamp(now + 2 * MONTH);
    let last = t.rp.execute(&id);
    assert_eq!(last.remaining, 0);
    assert_eq!(t.usdc.balance(&t.recipient), 75 * USDC);
    assert_eq!(t.usdc.balance(&t.payer), 925 * USDC);
    // Finished schedules are removed.
    assert_eq!(t.rp.get(&id), None);
    assert_eq!(t.rp.try_execute(&id).err(), Some(Ok(soroban_sdk::Error::from(Error::NotFound))));
}

#[test]
fn missed_periods_are_skipped_not_charged() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let id = t.rp.create(&t.payer, &t.recipient, &t.usdc.address, &(10 * USDC), &MONTH, &now, &12);

    // Keeper offline for 3.5 months: one payment, and the next is due at month 4.
    t.env.ledger().set_timestamp(now + 3 * MONTH + 15 * DAY);
    let s = t.rp.execute(&id);
    assert_eq!(s.next_due, now + 4 * MONTH);
    assert_eq!(s.remaining, 11);
    assert_eq!(t.rp.try_execute(&id).err(), Some(Ok(soroban_sdk::Error::from(Error::NotDue))));
    assert_eq!(t.usdc.balance(&t.recipient), 10 * USDC);
}

#[test]
fn future_start_waits() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let id = t.rp.create(&t.payer, &t.recipient, &t.usdc.address, &USDC, &DAY, &(now + DAY), &2);
    assert_eq!(t.rp.try_execute(&id).err(), Some(Ok(soroban_sdk::Error::from(Error::NotDue))));
    t.env.ledger().set_timestamp(now + DAY);
    t.rp.execute(&id);
    assert_eq!(t.usdc.balance(&t.recipient), USDC);
}

#[test]
fn payment_fails_without_allowance() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let id = t.rp.create(&t.payer, &t.recipient, &t.usdc.address, &(400 * USDC), &MONTH, &now, &1);
    // Allowance is 300; the transfer_from must fail and nothing moves.
    assert!(t.rp.try_execute(&id).is_err());
    assert_eq!(t.usdc.balance(&t.recipient), 0);
    assert!(t.rp.get(&id).is_some());
}

#[test]
fn either_party_can_cancel_but_no_one_else() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let a = t.rp.create(&t.payer, &t.recipient, &t.usdc.address, &USDC, &DAY, &now, &5);
    let b = t.rp.create(&t.payer, &t.recipient, &t.usdc.address, &USDC, &DAY, &now, &5);
    assert_eq!(b, a + 1);

    let stranger = Address::generate(&t.env);
    assert_eq!(t.rp.try_cancel(&a, &stranger).err(), Some(Ok(soroban_sdk::Error::from(Error::NotAuthorized))));
    t.rp.cancel(&a, &t.payer);
    t.rp.cancel(&b, &t.recipient);
    assert_eq!(t.rp.get(&a), None);
    assert_eq!(t.rp.get(&b), None);
}

#[test]
fn validates_inputs() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let (p, r, k) = (&t.payer, &t.recipient, &t.usdc.address);
    assert_eq!(t.rp.try_create(p, r, k, &0, &DAY, &now, &1).err(), Some(Ok(soroban_sdk::Error::from(Error::InvalidAmount))));
    assert_eq!(t.rp.try_create(p, r, k, &USDC, &60, &now, &1).err(), Some(Ok(soroban_sdk::Error::from(Error::InvalidInterval))));
    assert_eq!(t.rp.try_create(p, r, k, &USDC, &DAY, &now, &0).err(), Some(Ok(soroban_sdk::Error::from(Error::InvalidCount))));
    assert_eq!(t.rp.try_create(p, r, k, &USDC, &DAY, &now, &(MAX_COUNT + 1)).err(), Some(Ok(soroban_sdk::Error::from(Error::InvalidCount))));
    assert_eq!(t.rp.try_create(p, p, k, &USDC, &DAY, &now, &1).err(), Some(Ok(soroban_sdk::Error::from(Error::SamePayerAndRecipient))));
}

#[test]
fn create_requires_payer_signature() {
    let env = Env::default();
    let id = env.register(RecurringPayments, ());
    let rp = RecurringPaymentsClient::new(&env, &id);
    let (payer, recipient, token) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
    assert!(rp.try_create(&payer, &recipient, &token, &USDC, &DAY, &0, &1).is_err());
}
