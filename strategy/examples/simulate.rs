use std::env;
use std::error::Error;
use std::io;

use two_pool_power_strategy::{rebalance, Balances};

fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let (power, mut balances, prices) = if arguments.is_empty() {
        (
            100,
            Balances {
                long: 1_000_000_000,
                short: 1_000_000_000,
            },
            vec![100, 101, 100, 98, 100],
        )
    } else {
        if arguments.len() < 5 {
            return Err(
                "usage: simulate POWER LONG_RAW SHORT_RAW PRICE0 PRICE1 [PRICE2 ...]".into(),
            );
        }
        (
            arguments[0].parse::<u32>()?,
            Balances {
                long: arguments[1].parse::<u64>()?,
                short: arguments[2].parse::<u64>()?,
            },
            arguments[3..]
                .iter()
                .map(|value| value.parse::<u64>())
                .collect::<Result<Vec<_>, _>>()?,
        )
    };

    println!(
        "power={power} initial LONG={} SHORT={} total={}",
        balances.long,
        balances.short,
        balances.total()
    );
    println!("old -> new | direction | transfer | LONG | SHORT | retention Q64");
    for pair in prices.windows(2) {
        let step = rebalance(balances, pair[0], pair[1], power)
            .map_err(|error| io::Error::other(error.to_string()))?;
        println!(
            "{} -> {} | {:?} | {} | {} | {} | {}",
            pair[0],
            pair[1],
            step.direction,
            step.transfer,
            step.after.long,
            step.after.short,
            step.retention_q64,
        );
        balances = step.after;
    }
    Ok(())
}
