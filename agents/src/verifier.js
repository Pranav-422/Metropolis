// Objective verifier: the job spec carries a JSON Schema, and the output either matches it or not.
// Because the schema lives on-chain in the JobCreated event, anyone can re-run this check.
import Ajv from "ajv";
import { escrow, send } from "./config.js";

const ajv = new Ajv({ allErrors: true, strict: false });

export function checkOutput(spec, output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { passed: false, reason: "output is not valid JSON" };
  }
  const validate = ajv.compile(spec.schema);
  if (validate(parsed)) return { passed: true, reason: "output matches JSON schema" };
  const first = validate.errors[0];
  const where = first.instancePath || "(root)";
  return { passed: false, reason: `schema mismatch at ${where}: ${first.message}`.slice(0, 120) };
}

export async function verifyJob(verifierWallet, jobId, spec, output) {
  const verdict = checkOutput(spec, output);
  const receipt = await send(verifierWallet, escrow, "verify", [jobId, verdict.passed, verdict.reason]);
  return { ...verdict, receipt };
}
