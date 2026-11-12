extern crate std;

use super::*;
use soroban_sdk::{symbol_short, testutils::Address as _, testutils::Ledger, vec, Address, Env};

fn setup() -> (Env, PriceFeedClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let usdc = Address::generate(&env);
    let id = env.register(PriceFeed, (admin.clone(), Asset::Stellar(usdc), 14u32, 300u32));
    (env.clone(), PriceFeedClient::new(&env, &id), admin)
}

#[test]
fn publishes_and_reads_prices() {
    let (env, feed, _) = setup();
    env.ledger().set_timestamp(1_000);
    let btc = Asset::Other(symbol_short!("BTC"));
    let xlm = Asset::Other(symbol_short!("XLM"));

    assert_eq!(feed.lastprice(&btc), None);
    feed.set_prices(&vec![&env, (btc.clone(), 90_000_00000000000000), (xlm.clone(), 30_000_000_000_000)]);

    let p = feed.lastprice(&btc).unwrap();
    assert_eq!(p, PriceData { price: 90_000_00000000000000, timestamp: 1_000 });
    assert_eq!(feed.price(&btc, &1_000), Some(p.clone()));
    assert_eq!(feed.price(&btc, &999), None);
    assert_eq!(feed.prices(&btc, &5).unwrap().len(), 1);
    assert_eq!(feed.assets().len(), 2);
    assert_eq!(feed.decimals(), 14);
    assert_eq!(feed.resolution(), 300);

    // Updating an existing asset does not duplicate it.
    env.ledger().set_timestamp(1_300);
    feed.set_prices(&vec![&env, (btc.clone(), 91_000_00000000000000)]);
    assert_eq!(feed.assets().len(), 2);
    assert_eq!(feed.lastprice(&btc).unwrap().timestamp, 1_300);
}

#[test]
fn rejects_non_positive_prices() {
    let (env, feed, _) = setup();
    let r = feed.try_set_prices(&vec![&env, (Asset::Other(symbol_short!("ETH")), 0)]);
    assert_eq!(r.err(), Some(Ok(soroban_sdk::Error::from(Error::InvalidPrice))));
}

#[test]
fn only_admin_publishes() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(PriceFeed, (admin.clone(), Asset::Other(symbol_short!("USD")), 14u32, 300u32));
    let feed = PriceFeedClient::new(&env, &id);
    // No auths mocked: the admin signature is missing.
    let r = feed.try_set_prices(&vec![&env, (Asset::Other(symbol_short!("BTC")), 1)]);
    assert!(r.is_err());
}
