// Creates a passkey database in bookmarkd's format (schema, identity, and a
// webauthn-rs-core credential) plus the matching private key, which the
// passkey test loads into Chromium's virtual authenticator.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dir = new URL("../.e2e-passkey/", import.meta.url);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const b64url = buffer => Buffer.from(buffer).toString("base64url");
const userHandle = randomBytes(32);
const credentialId = randomBytes(16);
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });

const db = new DatabaseSync(new URL("auth.db", dir).pathname);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=1;
  CREATE TABLE identity(rp_id TEXT NOT NULL,user_id TEXT NOT NULL);
  CREATE TABLE credentials(id TEXT PRIMARY KEY,name TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,revoked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE grants(hash TEXT PRIMARY KEY,app TEXT NOT NULL,origin TEXT NOT NULL,expires INTEGER NOT NULL,binding TEXT);
  CREATE TABLE sessions(hash TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,credential TEXT NOT NULL,app TEXT NOT NULL,origin TEXT NOT NULL,csrf TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,recent INTEGER NOT NULL);
  CREATE INDEX sessions_scope ON sessions(app,origin);`);
db.prepare("INSERT INTO identity VALUES(?,?)").run("localhost", b64url(userHandle));
const credential = {
  cred_id: b64url(credentialId),
  cred: { type_: "ES256", key: { EC_EC2: { curve: "SECP256R1", x: jwk.x, y: jwk.y } } },
  counter: 0, transports: null, user_verified: true, backup_eligible: false, backup_state: false,
  registration_policy: "required",
  extensions: { cred_protect: "NotRequested", hmac_create_secret: "NotRequested", appid: "NotRequested", cred_props: "NotRequested" },
  attestation: { data: "None", metadata: "None" }, attestation_format: "none"
};
db.prepare("INSERT INTO credentials(id,name,data) VALUES(?,?,?)").run(b64url(credentialId), "Virtual authenticator", JSON.stringify(credential));
db.close();

writeFileSync(new URL("credential.json", dir), JSON.stringify({
  credentialId: credentialId.toString("base64"),
  userHandle: userHandle.toString("base64"),
  privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
}));
