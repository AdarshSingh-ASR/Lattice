import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { stableHash } from "./guardrails.mjs";

let s3;

export async function sealEvidence(receipt) {
  if (!process.env.EVIDENCE_BUCKET) {
    return { stored: false, hash: stableHash(receipt), reason: "bucket-not-configured" };
  }

  s3 ??= new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
  const body = JSON.stringify(receipt, null, 2);
  const hash = stableHash(receipt);
  const key = `incident-traces/${receipt.workspaceId}/${receipt.runId}/${hash}.json`;

  const result = await s3.send(
    new PutObjectCommand({
      Bucket: process.env.EVIDENCE_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      Metadata: {
        "lattice-hash": hash,
        "incident-id": String(receipt.incidentId),
      },
    }),
  );

  return {
    stored: true,
    bucket: process.env.EVIDENCE_BUCKET,
    key,
    versionId: result.VersionId ?? null,
    etag: result.ETag ?? null,
    hash,
  };
}
