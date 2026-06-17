---
title: 'Three ways to CPI in Solana (and when to use each)'
description: 'How to make a cross-program invocation (CPI) in Anchor — helper crates, declare_program!, or bare metal, when to use each, plus Meteora and Jupiter examples.'
pubDate: '2026-05-11'
draft: false
---

CPI (Cross-Program Invocation) is how a Solana program calls another program's
instruction from inside its own. Instead of reimplementing functionality, your
program invokes an existing one — account creation goes through the System
program, token transfers through the Token program, and so on. Think of it as
your program saying "I know a guy who can do this."

<nav class="toc" aria-label="Contents">

**On this page**

- [The three methods](#the-three-methods) — helper crates, `declare_program!`, and bare metal
- [Which method to use](#which-method-to-use) — the decision in three lines
- [Signing CPIs as a PDA](#signing-cpis-as-a-pda-with-invoke_signed) — `invoke_signed` and signer seeds
- [Walkthrough: Meteora DAMMv2](#walkthrough-cpi-into-meteora-dammv2) — `declare_program!` against a live pool
- [Walkthrough: Jupiter](#walkthrough-cpi-into-jupiter) — `remaining_accounts` and the `is_signer` dance

</nav>

Every CPI comes down to three pieces of information:

1. The **program ID** of the program to invoke.
2. The **accounts** to pass to the specific instruction.
3. The **data** to pass.

With those three things you can invoke any instruction of any program on the
chain. Hold onto this — it's the through-line for the rest of the post. The three
methods below are just three levels of help in assembling these same three pieces.

Everything here uses the Anchor framework.

## The three methods

Methods 1 and 2 are convenience wrappers. Under the hood they both produce the
same raw `(program ID, accounts, data)` that method 3 builds by hand.

### Method 1 — Helper crates

The most common programs ship Rust crates with the account structs and
instruction builders already implemented. Here's a token transfer from one
account to another:

```bash
cargo add anchor-spl
```

```rust
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

// within your instruction handler
transfer(
    CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.source_ata.to_account_info(),
            to: ctx.accounts.destination_ata.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        },
    ),
    amount,
)?;
```

Two things to watch with helper crates. They can fall behind if they aren't
actively maintained, and the crate version has to line up with your Anchor
version — for `anchor-spl`, match `anchor-lang` and enable the `idl-build`
feature:

```toml
[features]
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
```

### Method 2 — The `declare_program!` macro

This method needs the target program's IDL, which you can usually pull from
Solscan or Solana Explorer. Drop the IDL in your `/idls` directory and the macro
generates Rust modules for that program. Since most Solana programs are built
with Anchor, `declare_program!` removes the need for hand-maintained helper
crates and cuts down on dependency conflicts.

```bash
├── idls
│   └── jupiter.json
└── programs/your-program
    └── src
        └── lib.rs
```

```rust
// lib.rs
declare_id!("your-program-id");

declare_program!(jupiter);

// generated modules
use crate::jupiter::{
    cpi::{accounts::RouteV2, route_v2},
    program::Jupiter,
    types::RoutePlanStepV2,
};
```

The IDL must match the deployed program. If it doesn't, the transaction fails at
simulation or execution.

### Method 3 — Bare metal

The crudest option: supply the three pieces yourself — program ID, accounts,
data — with no helper structs. The previous two methods are wrappers over exactly
this. Here's the same token transfer, by hand:

```rust
// data => instruction discriminator + arguments.
// Anchor programs use the first 8 bytes of sha256("global:instruction_name")
// as the discriminator. The Token program uses a single byte: 3 => Transfer.
let mut data = Vec::with_capacity(9);
data.push(3);
data.extend_from_slice(&amount.to_le_bytes());

let instruction = Instruction {
    // program ID of the target program
    program_id: ctx.accounts.token_program.key(),
    // accounts the instruction expects, each tagged writable / signer
    accounts: vec![
        AccountMeta::new(ctx.accounts.source_ata.key(), false),
        AccountMeta::new(ctx.accounts.destination_ata.key(), false),
        AccountMeta::new_readonly(ctx.accounts.authority.key(), true),
    ],
    data,
};
let account_infos = &[
    ctx.accounts.source_ata.to_account_info(),
    ctx.accounts.destination_ata.to_account_info(),
    ctx.accounts.authority.to_account_info(),
];

invoke(&instruction, account_infos)?;
```

The hard part of bare metal is that the data layout and account list differ from
program to program, which makes it easy to get wrong. If the program isn't
documented, your best move is to find an existing transaction on Explorer and
reverse-engineer the accounts and data from it.

## Which method to use

- **Core / fundamental programs** (System, Token, Associated Token): use the
  **helper crate**.
- **IDL published and Anchor-compatible**: use **`declare_program!`** to generate
  the modules. (Some popular programs still ship helper crates, but that's fading
  since `declare_program!` landed.)
- **IDL unavailable or not Anchor-compatible**: drop to **bare metal** and supply
  the data yourself.

## Signing CPIs as a PDA with `invoke_signed`

So far every CPI has been authorized by an account that signs the outer
transaction — a user's keypair. But often the account that needs to authorize the
*inner* instruction is a PDA owned by your program: a vault that holds tokens, an
authority over a mint, a position held on a user's behalf. PDAs have no private
key, so they can't sign in the usual way. Instead, your program signs on the
PDA's behalf by proving it can derive the address — it passes the PDA's **seeds
and bump**. That's the whole difference between `invoke` and `invoke_signed`: the
signed variant takes those seeds. In Anchor it's `CpiContext::new_with_signer`
instead of `CpiContext::new`; everything else about the call is identical.

```rust
#[derive(Accounts)]
pub struct InstructionAccounts<'info> {
    // The PDA that owns the source account and authorizes the transfer.
    #[account(seeds = [b"vault"], bump)]
    pub vault: SystemAccount<'info>,
    // source_ata, destination_ata, token_program omitted for brevity
}

// in the handler
let signer_seeds: &[&[&[u8]]] = &[&[b"vault", &[ctx.bumps.vault]]];

transfer(
    CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.source_ata.to_account_info(),
            to: ctx.accounts.destination_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    ),
    amount,
)?;
```

The seeds you pass have to derive *exactly* the PDA you're claiming to sign for,
bump included. The bump matters: a PDA address is only valid for one bump (the
canonical one Anchor stores when it derives the account), and passing a different
one derives a different address — one your program isn't authorized to sign for.
Get the seeds or the bump wrong and the runtime rejects the CPI with a missing-
signature error, because the address you proved you can derive isn't the address
the inner instruction expects to sign.

## Walkthrough: CPI into Meteora DAMMv2

I'm building a liquidity-locking incentive program: a user locks their tokens for
a fixed duration (1, 3, or 6 months) and receives a bonus reward, paid by the
token admin. The locked tokens are deposited into a Meteora DAMMv2 pool on behalf
of a PDA so the program can enforce the lock. Meteora's IDL is published and
Anchor-compatible, so this is a Method 2 job.

Grab the IDL from
[Solscan](https://solscan.io/account/cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG#programIdl)
and save it as `/idls/cp_amm.json`, then add the macro in `lib.rs`:

```rust
declare_program!(cp_amm);
```

Meteora's
[docs](https://docs.meteora.ag/developer-guides/damm-v2/program/instructions)
show that providing liquidity takes two instructions: `create_position` (creates
an empty position) and `add_liquidity` (funds it). We'll walk through
`create_position`.

I'm passing Meteora's accounts through my own `DepositVault` struct rather than
through `remaining_accounts`. That lets me declare each account's type so Anchor
handles deserialization and constraint checks, and it means Anchor can derive the
PDAs at instruction-build time instead of me passing them all in by hand. Reading
the IDL, the accounts fall into three groups:

- **Constant accounts** with a fixed value (e.g. `pool_authority`).
- **PDA accounts** with known seeds (e.g. `position`).
- **Signer accounts** (e.g. `position_nft_mint`).

> **Gotcha:** for a PDA account you *can* type it as the generated type (e.g.
> `Position`) instead of `AccountInfo`. But if the account is only initialized
> *by the CPI itself*, that typing fails — at constraint-check time the account
> doesn't exist yet and is still owned by the System program. Use `AccountInfo`
> for accounts the inner program creates.

```rust
use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token::Token};

use crate::{
    cp_amm::{
        cpi::{accounts::CreatePosition, create_position},
        program::CpAmm,
    },
    state::Vault,
};

pub const DAMM_POOL_ADDRESS: Pubkey = pubkey!("8yswq8vqEDeTrN2Ez1Bdq2hRekzvFZgMxrdfUKVaNBtQ");
pub const POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct DepositVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    // PDA that holds the position on behalf of the user
    #[account(
        init,
        payer = user,
        space = 8 + Vault::INIT_SPACE,
        seeds = [
            b"vault",
            user.key().as_ref(),
            nonce.to_le_bytes().as_ref()
        ],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: checked by cpi
    #[account(address = DAMM_POOL_ADDRESS)]
    pub pool: AccountInfo<'info>,

    /// CHECK: checked by cpi
    #[account(
        mut,
        seeds = [
            b"position",
            position_nft_mint.key().as_ref(),
        ],
        bump,
        seeds::program = cp_amm,
    )]
    pub position: AccountInfo<'info>,

    #[account(mut)]
    pub position_nft_mint: Signer<'info>,

    /// CHECK: checked by cpi
    #[account(
        mut,
        seeds = [
            b"position_nft_account",
            position_nft_mint.key().as_ref(),
        ],
        bump,
        seeds::program = cp_amm,
    )]
    pub position_nft_account: AccountInfo<'info>,

    /// CHECK: checked by cpi
    #[account(address = POOL_AUTHORITY)]
    pub pool_authority: AccountInfo<'info>,

    /// CHECK: checked by cpi
    #[account(
        mut,
        seeds = [
            b"__event_authority",
            position_nft_mint.key().as_ref(),
        ],
        bump,
        seeds::program = cp_amm,
    )]
    pub event_authority: AccountInfo<'info>,

    pub cp_amm: Program<'info, CpAmm>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_vault_handler(ctx: Context<DepositVault>, nonce: u64) -> Result<()> {
    let user_pubkey = ctx.accounts.user.key();
    let nonce_bytes = nonce.to_le_bytes();

    // vault PDA signs the CPI so the position is owned on the user's behalf
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"vault",
        user_pubkey.as_ref(),
        nonce_bytes.as_ref(),
        &[ctx.bumps.vault],
    ]];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.cp_amm.to_account_info(),
        CreatePosition {
            owner: ctx.accounts.vault.to_account_info(),
            position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            pool_authority: ctx.accounts.pool_authority.to_account_info(),
            payer: ctx.accounts.user.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.cp_amm.to_account_info(),
        },
        signer_seeds,
    );

    create_position(cpi_ctx)?;

    // remaining program logic

    Ok(())
}
```

## Walkthrough: CPI into Jupiter

For this one I'm building a DCA program on top of Jupiter v6: a keeper triggers
each swap, and a position PDA is the account that actually swaps. Jupiter is a
curious case. Its
[IDL](https://solscan.io/account/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4#programIdl)
is published and works with `declare_program!`, but Method 2 alone doesn't get
you there. As a DEX aggregator, Jupiter CPIs into whatever venues the route
touches, and that route is decided off-chain — so the account list is variable
and there's no fixed `Accounts` struct to write. The answer is Methods 2 *and* 3
together: generated types for the data, `remaining_accounts` for the variable
accounts.

The flow:

1. Off-chain, get the route from Jupiter's API.
2. Pass the swap instruction's accounts as `remaining_accounts`, and its data as
   an instruction argument.
3. Record the vault balances before swapping.
4. CPI into Jupiter's swap with `invoke_signed` — the position PDA signs.
5. Reload the vaults and assert the balance deltas are what you expected.

Step 5 is the important one. You don't control Jupiter's internal routing, so
don't trust it — verify the on-chain effect. Confirm that exactly the input you
intended left the vault, and at least your minimum output arrived.

Off-chain, decode the instruction Jupiter returns and fix up the account flags
(more on why below):

```ts
export function decodeSwapIx(
  swapResponse: JupiterSwapResponse,
  pdaSigner: PublicKey,
): { remainingAccounts: AccountMeta[]; data: Buffer } {
  const remainingAccounts: AccountMeta[] = swapResponse.swapInstruction.accounts.map((a) => {
    const pubkey = new PublicKey(a.pubkey);
    // Jupiter marks our PDA as a signer, but a PDA can't sign the outer tx —
    // flip it to false here. We re-sign it inside the CPI instead.
    if (pubkey.equals(pdaSigner)) {
      return { pubkey, isWritable: true, isSigner: false };
    }
    return { pubkey, isWritable: a.isWritable, isSigner: a.isSigner };
  });
  const data = Buffer.from(swapResponse.swapInstruction.data, "base64");
  return { remainingAccounts, data };
}
```

On-chain, the handler records balances, signs the CPI as the PDA, and checks the
deltas afterward:

```rust
use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    error::DcaError,
    jupiter::{program::Jupiter, types::RoutePlanStepV2},
    state::Position,
    POSITION_SEED,
};

// obtained from jupiter IDL
#[derive(AnchorDeserialize, AnchorSerialize, Clone)]
pub struct SwapArgs {
    in_amount: u64,
    quoted_out_amount: u64,
    slippage_bps: u16,
    platform_fee_bps: u16,
    positive_slippage_bps: u16,
    route_plan: Vec<RoutePlanStepV2>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    pub keeper: Signer<'info>,

    #[account(
        mut,
        has_one = input_mint,
        has_one = output_mint,
    )]
    pub position: Account<'info, Position>,
    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = input_mint,
        associated_token::authority = position,
    )]
    pub input_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = output_mint,
        associated_token::authority = position,
    )]
    pub output_vault: Account<'info, TokenAccount>,

    pub jupiter_program: Program<'info, Jupiter>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: Jupiter's full route account list
}

pub fn execute_swap_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteSwap<'info>>,
    jupiter_data: Vec<u8>,
) -> Result<()> {

    let pre_in = ctx.accounts.input_vault.amount;
    let pre_out = ctx.accounts.output_vault.amount;

    // Optionally decode the args (declare_program! gives you the types) to
    // sanity-check before swapping; the balance delta below is the real guard.
    // Skip the leading 8-byte Anchor discriminator.
    let _swap_args = SwapArgs::try_from_slice(&jupiter_data[8..])?;

    let owner_key = ctx.accounts.position.owner;
    let nonce_bytes = ctx.accounts.position.nonce.to_le_bytes();
    let bump_arr = [ctx.accounts.position.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[
        POSITION_SEED,
        owner_key.as_ref(),
        nonce_bytes.as_ref(),
        &bump_arr,
    ]];

    swap_on_jupiter(
        ctx.remaining_accounts,
        ctx.accounts.jupiter_program.to_account_info(),
        &jupiter_data,
        &ctx.accounts.position.key(),
        signer_seeds,
    )?;

    ctx.accounts.input_vault.reload()?;
    ctx.accounts.output_vault.reload()?;

    let actual_in = pre_in
        .checked_sub(ctx.accounts.input_vault.amount)
        .ok_or(DcaError::MathOverflow)?;
    let actual_out = ctx
        .accounts
        .output_vault
        .amount
        .checked_sub(pre_out)
        .ok_or(DcaError::MathOverflow)?;

    let position = &mut ctx.accounts.position;
    require!(
        actual_in == position.amount_per_cycle,
        DcaError::UnexpectedInputDelta
    );

    require!(
        actual_out >= position.min_out_per_cycle,
        DcaError::SlippageExceeded
    );

    Ok(())
}

/// CPI into Jupiter. Marks the PDA as a signer in the AccountMeta list so
/// invoke_signed can sign for it with the position's seeds.
pub fn swap_on_jupiter<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    jupiter_program: AccountInfo<'info>,
    data: &[u8],
    pda_signer: &Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let accounts: Vec<AccountMeta> = remaining_accounts
        .iter()
        .map(|acc| AccountMeta {
            pubkey: *acc.key,
            is_signer: acc.key == pda_signer,
            is_writable: acc.is_writable,
        })
        .collect();

    invoke_signed(
        &Instruction {
            program_id: *jupiter_program.key,
            accounts,
            data: data.to_vec(),
        },
        remaining_accounts,
        signer_seeds,
    )
    .map_err(Into::into)
}
```

> **Gotcha — the `is_signer` dance.** Jupiter's API hands back the swap
> instruction with your PDA marked as a signer. Send that as-is and the
> transaction is rejected before it runs — a PDA has no key to sign the outer
> transaction. So off-chain you flip that account to `isSigner: false` (the
> `decodeSwapIx` step). Then, inside the CPI, you flip it *back* to
> `is_signer: true` in the `AccountMeta` you hand to `invoke_signed` — because at
> that point your program is signing on the PDA's behalf with its seeds.
> Off-chain false, on-chain true.

## Closing

Every CPI is the same three pieces — program ID, accounts, data — and the three
methods are just how much of that assembly you hand off. Reach for the lightest
wrapper the target program supports: a helper crate if one exists,
`declare_program!` if there's an IDL, bare metal only when you have to. Whatever
method you pick, the work that's left is almost always the accounts — getting the
right ones, in the right order, signed by the right authority.
