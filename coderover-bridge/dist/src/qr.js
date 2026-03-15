"use strict";
// FILE: qr.ts
// Purpose: Prints the pairing QR payload that the iPhone scanner expects.
Object.defineProperty(exports, "__esModule", { value: true });
exports.printQR = printQR;
const qrcodeTerminal = require("qrcode-terminal");
function printQR(pairingPayload) {
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
