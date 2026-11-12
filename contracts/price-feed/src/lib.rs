//! MINT price feed: a minimal SEP-40 oracle.
//!
//! MINT trades testnet copies of BTC, ETH, AQUA, CETES and the rest, which no public oracle prices.
//! This contract exposes the SEP-40 read interface (the one Reflector implements) so the guardrail
//! vault can be pointed at Reflector on mainnet without code changes. On testnet a single admin key
//! (MINT's worker) publishes the mainnet reference prices it already computes.
//!
//! Only the latest price per asset is kept: `price(asset, ts)` answers for that exact timestamp and
//! `prices(asset, n)` returns at most one record.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address, Env, Vec,
};

/// SEP-40 asset identifier.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(soroban_sdk::Symbol),
}

/// SEP-40 price record: `price` is in units of the base asset, scaled by `10^decimals()`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidPrice = 1,
    TooManyUpdates = 2,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    Base,
    Decimals,
    Resolution,
    Assets,
    Price(Asset),
}

#[contractevent(topics = ["prices_updated"])]
pub struct PricesUpdated {
    pub count: u32,
    pub timestamp: u64,
}

#[contractevent(topics = ["admin_changed"])]
pub struct AdminChanged {
    pub admin: Address,
}

const MAX_UPDATES: u32 = 50;
// Roughly 30 days of ledgers at ~5s; extended whenever a price is written.
const PRICE_TTL: u32 = 518_400;
const PRICE_TTL_THRESHOLD: u32 = PRICE_TTL / 2;

#[contract]
pub struct PriceFeed;

#[contractimpl]
impl PriceFeed {
    /// `base` is what prices are quoted in (USDC for MINT), `resolution` the expected update period
    /// in seconds.
    pub fn __constructor(env: Env, admin: Address, base: Asset, decimals: u32, resolution: u32) {
        let s = env.storage().instance();
        s.set(&Key::Admin, &admin);
        s.set(&Key::Base, &base);
        s.set(&Key::Decimals, &decimals);
        s.set(&Key::Resolution, &resolution);
        s.set(&Key::Assets, &Vec::<Asset>::new(&env));
    }

    // ── SEP-40 ──────────────────────────────────────────────────────────

    pub fn base(env: Env) -> Asset {
        env.storage().instance().get(&Key::Base).unwrap()
    }

    pub fn assets(env: Env) -> Vec<Asset> {
        env.storage().instance().get(&Key::Assets).unwrap()
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&Key::Decimals).unwrap()
    }

    pub fn resolution(env: Env) -> u32 {
        env.storage().instance().get(&Key::Resolution).unwrap()
    }

    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        env.storage().persistent().get(&Key::Price(asset))
    }

    pub fn price(env: Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        Self::lastprice(env, asset).filter(|p| p.timestamp == timestamp)
    }

    pub fn prices(env: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        if records == 0 {
            return None;
        }
        Self::lastprice(env.clone(), asset).map(|p| Vec::from_array(&env, [p]))
    }

    // ── Admin ───────────────────────────────────────────────────────────

    /// Publishes prices stamped with the current ledger time.
    pub fn set_prices(env: Env, updates: Vec<(Asset, i128)>) {
        Self::admin(env.clone()).require_auth();
        if updates.len() > MAX_UPDATES {
            panic_with_error!(&env, Error::TooManyUpdates);
        }
        let timestamp = env.ledger().timestamp();
        let instance = env.storage().instance();
        let mut assets: Vec<Asset> = instance.get(&Key::Assets).unwrap();
        for (asset, price) in updates.iter() {
            if price <= 0 {
                panic_with_error!(&env, Error::InvalidPrice);
            }
            if !assets.contains(&asset) {
                assets.push_back(asset.clone());
            }
            let key = Key::Price(asset);
            env.storage().persistent().set(&key, &PriceData { price, timestamp });
            env.storage().persistent().extend_ttl(&key, PRICE_TTL_THRESHOLD, PRICE_TTL);
        }
        instance.set(&Key::Assets, &assets);
        instance.extend_ttl(PRICE_TTL_THRESHOLD, PRICE_TTL);
        PricesUpdated { count: updates.len(), timestamp }.publish(&env);
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&Key::Admin).unwrap()
    }

    pub fn set_admin(env: Env, admin: Address) {
        Self::admin(env.clone()).require_auth();
        env.storage().instance().set(&Key::Admin, &admin);
        AdminChanged { admin }.publish(&env);
    }
}

#[cfg(test)]
mod test;
