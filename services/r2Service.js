const {
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { r2, bucket } = require('../config/cloudflareR2');

/**
 * Storage monitoring helper.
 * Walks the bucket with ListObjectsV2 and returns the exact bytes stored
 * and total object count. Optionally scoped to a key prefix.
 */
async function getBucketUsage(prefix) {
  let totalBytes = 0;
  let objectCount = 0;
  let token;
  do {
    const out = await r2.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
    );
    for (const obj of out.Contents || []) {
      totalBytes += obj.Size || 0;
      objectCount += 1;
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return { totalBytes, objectCount };
}

async function listKeys(prefix) {
  const keys = [];
  let token;
  do {
    const out = await r2.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
    );
    for (const obj of out.Contents || []) keys.push(obj.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Batch delete (max 1000 keys per request). */
async function deleteKeys(keys) {
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000);
    const out = await r2.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      })
    );
    if (out.Errors && out.Errors.length) {
      throw new Error(`R2 delete failed for ${out.Errors.length} object(s): ${out.Errors[0].Message}`);
    }
  }
  return unique.length;
}

async function deleteKey(key) {
  await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function deletePrefix(prefix) {
  let token;
  let deleted = 0;
  let truncated;
  do {
    const out = await r2.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
    );
    const keys = (out.Contents || []).map((obj) => obj.Key).filter(Boolean);
    await deleteKeys(keys);
    deleted += keys.length;
    truncated = out.IsTruncated;
    token = truncated ? out.NextContinuationToken : undefined;
    if (truncated && !token) throw new Error(`R2 did not return a continuation token while deleting ${prefix}.`);
  } while (truncated);
  return deleted;
}

async function headObject(key) {
  return r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

async function getObjectStream(key, abortSignal) {
  return r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal });
}

/* ---------------- multipart ---------------- */

async function createMultipart(key, contentType) {
  const out = await r2.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
    })
  );
  return out.UploadId;
}

/** Presign one part. ContentLength is signed so a part can't exceed its declared size. */
function presignPart({ key, uploadId, partNumber, length, expiresIn = 6 * 3600 }) {
  return getSignedUrl(
    r2,
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: length,
    }),
    { expiresIn }
  );
}

async function completeMultipart({ key, uploadId, parts }) {
  const sorted = [...parts]
    .map((p) => ({ PartNumber: Number(p.partNumber), ETag: p.etag }))
    .sort((a, b) => a.PartNumber - b.PartNumber);
  return r2.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted },
    })
  );
}

async function abortMultipart(key, uploadId) {
  try {
    await r2.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
  } catch (e) {
    // Already completed/aborted: safe to ignore
  }
}

/** Aborts in-progress multipart uploads older than `olderThanMs` (0 = all). Returns count aborted. */
async function abortStaleMultipartUploads(olderThanMs = 24 * 3600 * 1000) {
  let aborted = 0;
  let keyMarker;
  let uploadIdMarker;
  const cutoff = Date.now() - olderThanMs;
  do {
    const out = await r2.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
        MaxUploads: 1000,
      })
    );
    for (const u of out.Uploads || []) {
      if (!u.Initiated || u.Initiated.getTime() <= cutoff) {
        await abortMultipart(u.Key, u.UploadId);
        aborted += 1;
      }
    }
    keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
    uploadIdMarker = out.IsTruncated ? out.NextUploadIdMarker : undefined;
  } while (keyMarker || uploadIdMarker);
  return aborted;
}

/** Aborts all incomplete multipart uploads scoped to a room's object prefix. */
async function abortMultipartUploads(prefix) {
  let aborted = 0;
  let keyMarker;
  let uploadIdMarker;
  let truncated;
  do {
    const out = await r2.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
        MaxUploads: 1000,
      })
    );
    for (const upload of out.Uploads || []) {
      await r2.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        })
      );
      aborted += 1;
    }
    truncated = out.IsTruncated;
    keyMarker = truncated ? out.NextKeyMarker : undefined;
    uploadIdMarker = truncated ? out.NextUploadIdMarker : undefined;
    if (truncated && !keyMarker && !uploadIdMarker) {
      throw new Error(`R2 did not return multipart upload markers while cleaning ${prefix}.`);
    }
  } while (truncated);
  return aborted;
}

/** Presigned download URL that forces an attachment download of the untouched original. */
function presignDownload(key, fileName, expiresIn = 3600) {
  const safeName = String(fileName).replace(/["\\\r\n]/g, '_');
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    }),
    { expiresIn }
  );
}

function presignPreview(key, expiresIn = 900) {
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseCacheControl: 'private, max-age=300',
    }),
    { expiresIn }
  );
}

module.exports = {
  getBucketUsage,
  listKeys,
  deleteKeys,
  deleteKey,
  deletePrefix,
  abortMultipartUploads,
  headObject,
  createMultipart,
  presignPart,
  completeMultipart,
  abortMultipart,
  abortStaleMultipartUploads,
  getObjectStream,
  presignDownload,
  presignPreview,
};
