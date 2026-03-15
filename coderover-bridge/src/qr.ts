// FILE: qr.ts
// Purpose: Prints the pairing QR payload that the iPhone scanner expects.

import qrcodeTerminal = require("qrcode-terminal");

import type { TransportCandidateShape } from "./bridge-types";

export interface PairingPayloadShape {
  bridgeId: string;
  macDeviceId: string;
  transportCandidates?: TransportCandidateShape[];
  expiresAt: string | number;
  [key: string]: unknown;
}

export function printQR(pairingPayload: PairingPayloadShape): void {
  const payload = JSON.stringify(pairingPayload);

  console.log("\nScan this QR with the iPhone:\n");
  qrcodeTerminal.generate(payload, { small: true });
  console.log(`\nBridge ID: ${pairingPayload.bridgeId}`);
  console.log(`Device ID: ${pairingPayload.macDeviceId}`);
  for (const candidate of pairingPayload.transportCandidates || []) {
    console.log(`Transport [${candidate.kind}]: ${candidate.url}`);
  }
  console.log(`Expires: ${new Date(pairingPayload.expiresAt).toISOString()}\n`);
}
