/**
 * Refuse to use a PUBLISHED private key against anything but the devnet.
 *
 * Several scripts sign with Anvil account #0 (0xac0974…). That key is in every
 * Foundry tutorial; it is deliberately used on the devnet, where the chain
 * carries no value and the alternative is a key-management ceremony for a
 * laptop. But the scripts read RPC_URL and CHAIN_ID from .env, so repointing
 * .env at a testnet or mainnet made them sign real transactions — and make that
 * public address the OWNER of freshly deployed contracts — with a key anyone can
 * use. Nothing stopped it.
 *
 * This asks the NODE what chain it is (eth_chainId) rather than trusting .env,
 * because .env is exactly the thing that was wrong in that scenario.
 *
 * Override: GIGGORA_ALLOW_NON_DEVNET=1, which prints a loud warning and
 * continues. It exists for a deliberate testnet smoke test with a throwaway
 * key, not for convenience.
 */

export const DEVNET_CHAIN_ID = 4043;

/**
 * @param {{ getChainId: () => Promise<number | bigint> }} pub  a viem public client
 * @param {{ what?: string }} [opts]  the script name, for the message
 * @returns {Promise<number>} the live chain id
 */
export async function assertDevnet(pub, { what = "this script" } = {}) {
  const live = Number(await pub.getChainId());
  if (live === DEVNET_CHAIN_ID) return live;

  const msg =
    `\n  ${what} signs with a PUBLICLY KNOWN private key (Anvil account #0).\n` +
    `  The node at RPC_URL reports chain id ${live}, not the devnet (${DEVNET_CHAIN_ID}).\n`;

  if (process.env.GIGGORA_ALLOW_NON_DEVNET === "1") {
    console.error(
      msg +
        `  GIGGORA_ALLOW_NON_DEVNET=1 is set — continuing. Anything this key deploys or owns\n` +
        `  on chain ${live} can be taken by anyone.\n`
    );
    return live;
  }

  console.error(
    msg +
      `  Refusing. Set GIGGORA_ALLOW_NON_DEVNET=1 to override for a deliberate throwaway test.\n`
  );
  process.exit(1);
}
