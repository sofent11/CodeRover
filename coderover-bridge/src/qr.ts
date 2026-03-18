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

export function renderQR(pairingPayload: PairingPayloadShape): string {
  const payload = JSON.stringify(pairingPayload);
  let rendered = "";
  qrcodeTerminal.generate(payload, { small: true }, (output) => {
    rendered = output;
  });
  return rendered;
}

export function printQR(pairingPayload: PairingPayloadShape): void {
  console.log("\nScan this QR with the iPhone:\n");
  console.log(renderQR(pairingPayload));
  console.log(`\nBridge ID: ${pairingPayload.bridgeId}`);
  console.log(`Device ID: ${pairingPayload.macDeviceId}`);
  for (const candidate of pairingPayload.transportCandidates || []) {
    console.log(`Transport [${candidate.kind}]: ${candidate.url}`);
  }
  console.log(`Expires: ${new Date(pairingPayload.expiresAt).toISOString()}\n`);
}
