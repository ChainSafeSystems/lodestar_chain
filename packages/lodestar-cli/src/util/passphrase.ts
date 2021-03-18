import fs from "fs";
import {stripOffNewlines} from "./stripOffNewlines";
import {writeFile600Perm} from "./fs";
import {getValidatorPassphrasePath} from "../validatorDir/paths";

/**
 * Utility to read file as UTF8 and strip any trailing new lines.
 * All passphrase files must be read with this function
 */
export function readPassphraseFile(passphraseFile: string): string {
  const data = fs.readFileSync(passphraseFile, "utf8");
  const passphrase = stripOffNewlines(data);

  // Validate the passphraseFile contents to prevent the user to create a wallet with a password
  // that is the contents a random unintended file
  try {
    if (passphrase.includes("\n")) throw Error("contains multiple lines");
    // 512 is an arbitrary high number that should be longer than any actual passphrase
    if (passphrase.length > 512) throw Error("is really long");
  } catch (e: unknown) {
    throw new Error(`passphraseFile ${passphraseFile} ${e.message}. Is this a well-formated passphraseFile?`);
  }

  return passphrase;
}

export function readValidatorPassphrase({secretsDir, pubkey}: {secretsDir: string; pubkey: string}): string {
  const notPrefixedPath = getValidatorPassphrasePath({secretsDir, pubkey});
  const prefixedPath = getValidatorPassphrasePath({secretsDir, pubkey, prefixed: true});
  if (fs.existsSync(notPrefixedPath)) {
    return readPassphraseFile(notPrefixedPath);
  } else {
    return readPassphraseFile(prefixedPath);
  }
}

export function writeValidatorPassphrase({
  secretsDir,
  pubkey,
  passphrase,
}: {
  secretsDir: string;
  pubkey: string;
  passphrase: string;
}): void {
  writeFile600Perm(getValidatorPassphrasePath({secretsDir, pubkey, prefixed: true}), passphrase);
}
