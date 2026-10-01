#![no_std]

//! Pure, deterministic two-pool power transfer math.
//!
//! Both sides must hold raw units of the *same* collateral mint. Oracle prices
//! must use the same positive scale. This crate does no oracle verification,
//! token movement, minting, redemption, or market making.

use core::fmt;

/// A 1.0 retention multiplier in unsigned Q64 fixed point.
pub const Q64_ONE: u128 = 1u128 << 64;

/// Highest accepted raw oracle price in one consistent integer scale.
///
/// This bound keeps a one-unit price move resolvable relative to Q64 rounding
/// even at the maximum supported power. It is a policy bound, not a u64 limit.
pub const MAX_ORACLE_PRICE: u64 = 1_000_000_000_000_000;

/// Highest accepted power exponent for the documented Q64 error budget.
pub const MAX_POWER: u32 = 100_000;

/// Raw balances of one fungible collateral asset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Balances {
    pub long: u64,
    pub short: u64,
}

impl Balances {
    pub const fn total(self) -> u128 {
        self.long as u128 + self.short as u128
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
    Flat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MathError {
    ZeroPrice,
    PriceTooHigh,
    ZeroCollateralSide,
    ZeroPower,
    PowerTooHigh,
    WinnerBalanceOverflow,
}

impl fmt::Display for MathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroPrice => f.write_str("oracle prices must be positive"),
            Self::PriceTooHigh => f.write_str("oracle price exceeds supported raw-price ceiling"),
            Self::ZeroCollateralSide => f.write_str("both collateral sides must start positive"),
            Self::ZeroPower => f.write_str("power must be at least one"),
            Self::PowerTooHigh => f.write_str("power exceeds supported exponent ceiling"),
            Self::WinnerBalanceOverflow => f.write_str("winner raw balance would exceed u64"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rebalance {
    pub before: Balances,
    pub after: Balances,
    pub direction: Direction,
    /// Raw units moved from the losing side to the winning side.
    pub transfer: u64,
    /// Losing-side retention, approximately `(min_price / max_price)^power`.
    /// A zero here means the Q64 multiplier underflowed; the one-unit raw
    /// collateral floor still applies.
    pub retention_q64: u128,
}

#[inline]
fn q64_mul_down(a: u128, b: u128) -> u128 {
    debug_assert!(a <= Q64_ONE && b <= Q64_ONE);
    // Short-circuit the sole Q64 multiplication (1.0 * 1.0) whose unshifted
    // product would be 2^128 and therefore cannot fit in u128.
    if a == Q64_ONE {
        return b;
    }
    if b == Q64_ONE {
        return a;
    }
    (a * b) >> 64
}

/// Compute `(numerator / denominator)^power` in Q64, rounding down.
///
/// For accepted power `k`, the absolute gap from the exact real-number
/// retention fraction is strictly less than `2k / 2^64`. Each floored square
/// contributes at most one Q64 unit, with errors propagated through factors
/// in `[0, 1]`. Exponentiation takes at most 34 Q64 multiplications within the
/// supported range. The caller supplies `0 < numerator < denominator`.
fn ratio_power_q64(numerator: u64, denominator: u64, power: u32) -> u128 {
    debug_assert!(numerator > 0 && numerator < denominator && power > 0);
    let mut base = ((numerator as u128) << 64) / denominator as u128;
    let mut exponent = power;
    let mut result = Q64_ONE;
    while exponent > 0 {
        if exponent & 1 == 1 {
            result = q64_mul_down(result, base);
        }
        exponent >>= 1;
        if exponent > 0 {
            base = q64_mul_down(base, base);
        }
    }
    result
}

#[inline]
fn retained_collateral(loser: u64, retention_q64: u128) -> u64 {
    // Ceil rather than floor so rounding never transfers *more* than the
    // fixed-point fraction permits. The product and rounding term fit u128:
    // loser <= 2^64-1 and retention < 2^64 on every price move.
    let product = loser as u128 * retention_q64;
    let rounded_up = (product + Q64_ONE - 1) >> 64;
    rounded_up.max(1).min(loser as u128) as u64
}

/// Apply the user-selected power transfer for one oracle price transition.
///
/// * Up: SHORT retains approximately `(old_price / new_price)^power` and
///   transfers the rest to LONG.
/// * Down: LONG retains approximately `(new_price / old_price)^power` and
///   transfers the rest to SHORT.
/// * Flat: no transfer.
///
/// At least one raw unit remains on each side. Both sides retain positive
/// balances, so a losing side can receive collateral after a reversal.
/// The returned balances conserve their `u128` total exactly. An overflow of
/// the winning `u64` account returns an error with no state change. Prices must
/// be at most [`MAX_ORACLE_PRICE`] and power at most [`MAX_POWER`], including on
/// a flat-price update.
pub fn rebalance(
    balances: Balances,
    old_price: u64,
    new_price: u64,
    power: u32,
) -> Result<Rebalance, MathError> {
    if old_price == 0 || new_price == 0 {
        return Err(MathError::ZeroPrice);
    }
    if old_price > MAX_ORACLE_PRICE || new_price > MAX_ORACLE_PRICE {
        return Err(MathError::PriceTooHigh);
    }
    if balances.long == 0 || balances.short == 0 {
        return Err(MathError::ZeroCollateralSide);
    }
    if power == 0 {
        return Err(MathError::ZeroPower);
    }
    if power > MAX_POWER {
        return Err(MathError::PowerTooHigh);
    }
    if old_price == new_price {
        return Ok(Rebalance {
            before: balances,
            after: balances,
            direction: Direction::Flat,
            transfer: 0,
            retention_q64: Q64_ONE,
        });
    }

    if new_price > old_price {
        let retention = ratio_power_q64(old_price, new_price, power);
        let new_short = retained_collateral(balances.short, retention);
        let transfer = balances.short - new_short;
        let new_long = balances
            .long
            .checked_add(transfer)
            .ok_or(MathError::WinnerBalanceOverflow)?;
        Ok(Rebalance {
            before: balances,
            after: Balances {
                long: new_long,
                short: new_short,
            },
            direction: Direction::Up,
            transfer,
            retention_q64: retention,
        })
    } else {
        let retention = ratio_power_q64(new_price, old_price, power);
        let new_long = retained_collateral(balances.long, retention);
        let transfer = balances.long - new_long;
        let new_short = balances
            .short
            .checked_add(transfer)
            .ok_or(MathError::WinnerBalanceOverflow)?;
        Ok(Rebalance {
            before: balances,
            after: Balances {
                long: new_long,
                short: new_short,
            },
            direction: Direction::Down,
            transfer,
            retention_q64: retention,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rising_price_moves_short_to_long_and_conserves_collateral() {
        let before = Balances {
            long: 1_000_000,
            short: 1_000_000,
        };
        let result = rebalance(before, 100, 110, 2).unwrap();
        assert_eq!(result.direction, Direction::Up);
        assert!(result.transfer > 0);
        assert_eq!(result.after.total(), before.total());
        assert_eq!(result.after.long - before.long, result.transfer);
        assert_eq!(before.short - result.after.short, result.transfer);
        assert!(result.after.short >= 1);
    }

    #[test]
    fn falling_price_moves_long_to_short_and_conserves_collateral() {
        let before = Balances {
            long: 1_000_000,
            short: 1_000_000,
        };
        let result = rebalance(before, 110, 100, 2).unwrap();
        assert_eq!(result.direction, Direction::Down);
        assert!(result.transfer > 0);
        assert_eq!(result.after.total(), before.total());
        assert_eq!(result.after.short - before.short, result.transfer);
        assert_eq!(before.long - result.after.long, result.transfer);
        assert!(result.after.long >= 1);
    }

    #[test]
    fn simple_power_retention_matches_exact_binary_price_ratio() {
        let before = Balances {
            long: 1_000,
            short: 1_000,
        };
        let once = rebalance(before, 100, 200, 1).unwrap();
        assert_eq!(once.retention_q64, Q64_ONE / 2);
        assert_eq!(
            once.after,
            Balances {
                long: 1_500,
                short: 500
            }
        );
        let twice = rebalance(before, 100, 200, 2).unwrap();
        assert_eq!(twice.retention_q64, Q64_ONE / 4);
        assert_eq!(
            twice.after,
            Balances {
                long: 1_750,
                short: 250
            }
        );
    }

    #[test]
    fn extreme_power_preserves_one_unit_then_allows_reversal() {
        let initial = Balances {
            long: 1_000_000_000,
            short: 1_000_000_000,
        };
        let up = rebalance(initial, 100, 101, 100_000).unwrap();
        assert_eq!(up.after.short, 1);
        assert_eq!(up.after.total(), initial.total());
        let down = rebalance(up.after, 101, 100, 100_000).unwrap();
        assert_eq!(down.after.long, 1);
        assert!(down.after.short > up.after.short);
        assert_eq!(down.after.total(), initial.total());
        // A round trip is path dependent; it does not restore initial NAVs.
        assert_ne!(down.after, initial);
    }

    #[test]
    fn supports_max_power_in_logarithmic_time() {
        let result = rebalance(Balances { long: 4, short: 5 }, 100, 101, MAX_POWER).unwrap();
        assert_eq!(result.after, Balances { long: 8, short: 1 });
    }

    #[test]
    fn oracle_and_power_domain_is_enforced_even_on_flat_updates() {
        let before = Balances { long: 1, short: 2 };
        assert!(rebalance(before, MAX_ORACLE_PRICE - 1, MAX_ORACLE_PRICE, MAX_POWER).is_ok());
        assert_eq!(
            rebalance(before, MAX_ORACLE_PRICE + 1, MAX_ORACLE_PRICE, 1),
            Err(MathError::PriceTooHigh)
        );
        assert_eq!(
            rebalance(before, MAX_ORACLE_PRICE, MAX_ORACLE_PRICE + 1, 1),
            Err(MathError::PriceTooHigh)
        );
        assert_eq!(
            rebalance(before, MAX_ORACLE_PRICE + 1, MAX_ORACLE_PRICE + 1, 1),
            Err(MathError::PriceTooHigh)
        );
        assert_eq!(
            rebalance(before, 1, 2, MAX_POWER + 1),
            Err(MathError::PowerTooHigh)
        );
        assert_eq!(
            rebalance(before, 1, 1, MAX_POWER + 1),
            Err(MathError::PowerTooHigh)
        );
    }

    #[test]
    fn worst_price_tick_at_domain_edge_respects_q64_error_budget() {
        let loser = u64::MAX / 2;
        let result = rebalance(
            Balances {
                long: 1,
                short: loser,
            },
            MAX_ORACLE_PRICE - 1,
            MAX_ORACLE_PRICE,
            MAX_POWER,
        )
        .unwrap();
        // The first-order loss is an upper bound on the ideal real-number
        // loss. Its second-order correction is < 1 raw unit for this case.
        let first_order = (loser as u128 * MAX_POWER as u128) / MAX_ORACLE_PRICE as u128;
        let q64_error_bound = (loser as u128 * 2 * MAX_POWER as u128).div_ceil(Q64_ONE);
        assert!(result.transfer as u128 >= first_order - 1);
        assert!(result.transfer as u128 <= first_order + q64_error_bound + 1);
    }

    #[test]
    fn flat_price_is_exact_no_op() {
        let before = Balances { long: 1, short: 2 };
        let result = rebalance(before, 123, 123, 100_000).unwrap();
        assert_eq!(result.direction, Direction::Flat);
        assert_eq!(result.transfer, 0);
        assert_eq!(result.retention_q64, Q64_ONE);
        assert_eq!(result.after, before);
    }

    #[test]
    fn invalid_inputs_and_winner_overflow_fail() {
        let before = Balances {
            long: 10,
            short: 10,
        };
        assert_eq!(rebalance(before, 0, 1, 1), Err(MathError::ZeroPrice));
        assert_eq!(rebalance(before, 1, 1, 0), Err(MathError::ZeroPower));
        assert_eq!(
            rebalance(Balances { long: 0, short: 10 }, 1, 2, 1),
            Err(MathError::ZeroCollateralSide)
        );
        assert_eq!(
            rebalance(
                Balances {
                    long: u64::MAX,
                    short: u64::MAX,
                },
                1,
                2,
                1,
            ),
            Err(MathError::WinnerBalanceOverflow)
        );
    }

    #[test]
    fn repeated_moves_conserve_total_and_never_zero_a_side() {
        let prices = [100, 101, 99, 120, 80, 100, 100, 90, 130];
        for power in [1, 2, 3, 100, 100_000] {
            let mut balances = Balances {
                long: 700_000_000,
                short: 300_000_000,
            };
            let total = balances.total();
            for pair in prices.windows(2) {
                balances = rebalance(balances, pair[0], pair[1], power).unwrap().after;
                assert_eq!(balances.total(), total);
                assert!(balances.long >= 1 && balances.short >= 1);
            }
        }
    }
}
