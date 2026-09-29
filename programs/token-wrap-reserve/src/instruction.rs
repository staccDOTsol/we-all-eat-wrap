//! Versioned wire ABI; no inherited token-wrap instruction is repurposed.
use crate::{
    state::{Addresses, Fees, Key},
    tokens, ID,
};
use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::Address;
use solana_instruction::{AccountMeta, Instruction};
pub const PREFIX: &[u8; 8] = b"TWRSIX01";
#[derive(Debug, Clone, BorshDeserialize, BorshSerialize)]
pub enum WrapInstruction {
    CreateMint {
        nonce: Key,
        fees: Fees,
        amount: u64,
        min_wrapped: u64,
    },
    Wrap {
        amount: u64,
        min_wrapped: u64,
    },
    Unwrap {
        shares: u64,
        min_unwrapped_received: u64,
    },
    Harvest,
    ScheduleFees {
        fees: Fees,
    },
}
pub fn encode(i: &WrapInstruction) -> Vec<u8> {
    let mut data = PREFIX.to_vec();
    data.extend(borsh::to_vec(i).expect("serialize instruction"));
    data
}
fn w(k: Address) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn r(k: Address) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
fn s(k: Address) -> AccountMeta {
    AccountMeta::new(k, true)
}
#[allow(clippy::too_many_arguments)]
pub fn create_mint(
    creator: Address,
    nonce: Key,
    unwrapped: Address,
    unwrapped_program: Address,
    source: Address,
    reward: Address,
    fees: Fees,
    amount: u64,
    min_wrapped: u64,
) -> Instruction {
    let a = Addresses::new(&ID, &creator, &nonce);
    let dest=spl_associated_token_account_interface::address::get_associated_token_address_with_program_id(&creator,&a.wrapped,&tokens::T22);
    Instruction {
        program_id: ID,
        accounts: vec![
            s(creator),
            w(a.config),
            w(a.wrapped),
            r(unwrapped),
            w(source),
            w(a.reserve),
            w(a.locked),
            w(a.lp),
            w(a.bids),
            w(a.collector),
            w(dest),
            r(reward),
            r(unwrapped_program),
            r(tokens::T22),
            r(pinocchio_system::ID),
            r(spl_associated_token_account_interface::program::ID),
        ],
        data: encode(&WrapInstruction::CreateMint {
            nonce,
            fees,
            amount,
            min_wrapped,
        }),
    }
}
/// Wrap/unwrap use the same account order. `unwrapped_account` is owned by `user`;
/// `wrapped_account` is likewise user-owned. Programs never select destinations.
#[allow(clippy::too_many_arguments)]
pub fn trade(
    user: Address,
    config: Address,
    unwrapped: Address,
    unwrapped_program: Address,
    unwrapped_account: Address,
    wrapped_account: Address,
    instruction: WrapInstruction,
) -> Instruction {
    assert!(matches!(
        instruction,
        WrapInstruction::Wrap { .. } | WrapInstruction::Unwrap { .. }
    ));
    let a = Addresses::for_config(&ID, &config);
    Instruction {
        program_id: ID,
        accounts: vec![
            r_signer(user),
            r(config),
            w(a.wrapped),
            r(unwrapped),
            w(unwrapped_account),
            w(a.reserve),
            w(wrapped_account),
            r(a.locked),
            w(a.lp),
            w(a.bids),
            r(unwrapped_program),
            r(tokens::T22),
        ],
        data: encode(&instruction),
    }
}
fn r_signer(k: Address) -> AccountMeta {
    AccountMeta::new_readonly(k, true)
}
pub fn harvest(config: Address, unwrapped: Address, sources: &[Address]) -> Instruction {
    let a = Addresses::for_config(&ID, &config);
    let mut accounts = vec![
        r(config),
        w(a.wrapped),
        r(unwrapped),
        r(a.reserve),
        r(a.locked),
        w(a.lp),
        w(a.bids),
        w(a.collector),
        r(tokens::T22),
    ];
    accounts.extend(sources.iter().copied().map(w));
    Instruction {
        program_id: ID,
        accounts,
        data: encode(&WrapInstruction::Harvest),
    }
}
pub fn schedule_fees(creator: Address, config: Address, fees: Fees) -> Instruction {
    let a = Addresses::for_config(&ID, &config);
    Instruction {
        program_id: ID,
        accounts: vec![r_signer(creator), w(config), w(a.wrapped), r(tokens::T22)],
        data: encode(&WrapInstruction::ScheduleFees { fees }),
    }
}
