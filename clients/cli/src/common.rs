use {
    crate::{config::Config, output::println_display, Error},
    clap::ArgMatches,
    solana_clap_v3_utils::keypair::pubkey_from_path,
    solana_client::nonblocking::rpc_client::RpcClient,
    solana_instruction::{AccountMeta, Instruction},
    solana_presigner::Presigner,
    solana_pubkey::Pubkey,
    solana_signature::Signature,
    solana_transaction::Transaction,
    spl_token_2022_interface::{
        extension::{PodStateWithExtensions, StateWithExtensions},
        pod::PodAccount,
        state::Mint,
    },
    std::str::FromStr,
};

pub fn parse_pubkey(value: &str) -> Result<Pubkey, String> {
    parse_address(value, "pubkey")
}

fn parse_address(path: &str, name: &str) -> Result<Pubkey, String> {
    let mut wallet_manager = None;
    pubkey_from_path(&ArgMatches::default(), path, name, &mut wallet_manager)
        .map_err(|_| format!("Failed to load pubkey {} at {}", name, path))
}

pub fn parse_token_program(value: &str) -> Result<Pubkey, String> {
    let pubkey = parse_pubkey(value)?;
    if pubkey == spl_token::id() || pubkey == spl_token_2022_interface::id() {
        Ok(pubkey)
    } else {
        Err("Invalid token program. Must be spl-token or spl-token-2022".to_string())
    }
}

/// An account required by a Token-2022 transfer hook. The caller supplies
/// these in the order expected by the hook's extra-account-metas list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookAccount {
    pub address: Pubkey,
    pub writable: bool,
}

/// Parse `PUBKEY` (read-only) or `PUBKEY:writable`.
/// Hook accounts supplied through this option are never transaction signers.
pub fn parse_hook_account(value: &str) -> Result<HookAccount, String> {
    let (address, access) = value.split_once(':').unwrap_or((value, "readonly"));
    let writable = match access {
        "readonly" => false,
        "writable" => true,
        _ => return Err("Hook account must be PUBKEY or PUBKEY:writable".to_string()),
    };
    let address =
        Pubkey::from_str(address).map_err(|_| format!("Invalid hook account pubkey: {address}"))?;
    Ok(HookAccount { address, writable })
}

pub fn append_hook_accounts(instruction: &mut Instruction, hook_accounts: &[HookAccount]) {
    instruction
        .accounts
        .extend(hook_accounts.iter().map(|account| {
            if account.writable {
                AccountMeta::new(account.address, false)
            } else {
                AccountMeta::new_readonly(account.address, false)
            }
        }));
}

pub fn parse_presigner(value: &str) -> Result<Presigner, String> {
    let (pubkey_string, sig_string) = value
        .split_once('=')
        .ok_or("failed to split `pubkey=signature` pair")?;
    let pubkey = Pubkey::from_str(pubkey_string)
        .map_err(|_| "Failed to parse pubkey from string".to_string())?;
    let sig = Signature::from_str(sig_string)
        .map_err(|_| "Failed to parse signature from string".to_string())?;
    Ok(Presigner::new(&pubkey, &sig))
}

pub async fn process_transaction(
    config: &Config,
    transaction: Transaction,
) -> Result<Option<Signature>, Error> {
    if config.dry_run {
        let simulation_data = config.rpc_client.simulate_transaction(&transaction).await?;

        if config.verbose() {
            if let Some(logs) = simulation_data.value.logs {
                for log in logs {
                    println!("    {}", log);
                }
            }

            println!(
                "\nSimulation succeeded, consumed {} compute units",
                simulation_data.value.units_consumed.unwrap()
            );
        } else {
            println_display(config, "Simulation succeeded".to_string());
        }

        Ok(None)
    } else {
        Ok(Some(
            config
                .rpc_client
                .send_and_confirm_transaction_with_spinner(&transaction)
                .await?,
        ))
    }
}

pub async fn get_mint_for_token_account(
    rpc_client: &RpcClient,
    token_account_address: &Pubkey,
) -> Result<Pubkey, Error> {
    let token_account_info = rpc_client.get_account(token_account_address).await?;
    let unpacked_account = PodStateWithExtensions::<PodAccount>::unpack(&token_account_info.data)?;
    Ok(unpacked_account.base.mint)
}

pub async fn get_account_owner(rpc_client: &RpcClient, account: &Pubkey) -> Result<Pubkey, Error> {
    let owner = rpc_client.get_account(account).await?.owner;
    Ok(owner)
}

pub async fn assert_mint_account(
    rpc_client: &RpcClient,
    account_key: &Pubkey,
) -> Result<(), String> {
    let account_info = rpc_client
        .get_account(account_key)
        .await
        .map_err(|e| format!("Failed to fetch account {}: {}", account_key, e))?;

    let owner = account_info.owner;
    if owner != spl_token::id() && owner != spl_token_2022_interface::id() {
        return Err(format!(
            "Account {} is not owned by a token program. Owner: {}",
            account_key, owner
        ));
    }

    // Attempt to deserialize the data as a mint account
    let _ = StateWithExtensions::<Mint>::unpack(&account_info.data)
        .map_err(|e| format!("Failed to unpack as spl token mint: {:?}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_accounts_preserve_order_and_permissions() {
        let first = Pubkey::new_from_array([1; 32]);
        let second = Pubkey::new_from_array([2; 32]);
        let accounts = [
            parse_hook_account(&first.to_string()).unwrap(),
            parse_hook_account(&format!("{second}:writable")).unwrap(),
        ];
        let mut instruction = Instruction::new_with_bytes(
            Pubkey::new_from_array([3; 32]),
            &[],
            vec![AccountMeta::new_readonly(
                Pubkey::new_from_array([4; 32]),
                false,
            )],
        );

        append_hook_accounts(&mut instruction, &accounts);

        assert_eq!(instruction.accounts.len(), 3);
        assert_eq!(
            instruction.accounts[1],
            AccountMeta::new_readonly(first, false)
        );
        assert_eq!(instruction.accounts[2], AccountMeta::new(second, false));
    }

    #[test]
    fn hook_account_rejects_signer_and_unknown_modes() {
        let address = Pubkey::new_from_array([1; 32]);
        assert!(parse_hook_account(&format!("{address}:signer")).is_err());
        assert!(parse_hook_account(&format!("{address}:writeable")).is_err());
        assert!(parse_hook_account("not-a-pubkey").is_err());
    }
}
