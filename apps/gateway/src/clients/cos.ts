/**
 * 腾讯云 COS 私有桶文件存储（文件管理模块）
 * 实测接口（2026-09-10，账号 1349800710，私有桶 7374-study-...-1349800710）：
 * - putObject({ Bucket, Region, Key, Body, ContentType }) → { ETag }
 * - getObjectUrl({ Bucket, Region, Key, Sign:true, Method:'GET', Expires, Query }) → 签名 URL
 * - 私有桶无签名 URL 无法访问；加 response-content-disposition=inline 以预览而非下载
 */
import COS from 'cos-nodejs-sdk-v5';
import { config } from '../config.js';

let cos: COS | null = null;

function getCos(): COS {
  if (cos) return cos;
  cos = new COS({
    SecretId: config.cosStorage.secretId,
    SecretKey: config.cosStorage.secretKey,
  });
  return cos;
}

/** COS 私有桶存储是否已启用且配置完整 */
export function cosStorageEnabled(): boolean {
  return (
    config.cosStorage.enabled &&
    !!(config.cosStorage.secretId && config.cosStorage.secretKey && config.cosStorage.bucket)
  );
}

export interface StoredUploadResult {
  /** 对象路径（Key），如 kb/2026-09-10/xxx.png */
  objectKey: string;
  bucket: string;
}

/** 上传 Buffer 到 COS 私有桶对象，返回对象路径与桶名 */
export async function uploadObject(
  objectKey: string,
  body: Buffer,
  contentType?: string,
): Promise<StoredUploadResult> {
  const { bucket, region } = config.cosStorage;
  await getCos().putObject({
    Bucket: bucket,
    Region: region,
    Key: objectKey,
    Body: body,
    ContentType: contentType ?? 'application/octet-stream',
  });
  return { objectKey, bucket };
}

export interface SignedViewUrl {
  objectKey: string;
  /** 带签名的临时访问 URL（私有桶必需），直接 GET 即触发下载 */
  url: string;
  /** URL 过期时间（unix 秒） */
  expiresAt: number;
}

/**
 * 生成对象签名 URL（私有桶访问必需）。
 * 说明：COS 默认域名对 2024 年后创建的私有桶强制返回 Content-Disposition: attachment，
 * 且无备案域名无法绑定自定义域名做浏览器 inline 预览，因此 GET 该 URL 将直接触发下载。
 * expireSeconds 默认 7200（2 小时）。
 */
export function getSignedViewUrl(objectKey: string, expireSeconds = 7200): Promise<SignedViewUrl> {
  const { bucket, region } = config.cosStorage;
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    getCos().getObjectUrl(
      {
        Bucket: bucket,
        Region: region,
        Key: objectKey,
        Sign: true,
        Method: 'GET',
        Expires: expireSeconds,
      },
      (err: COS.CosError | null, data?: COS.GetObjectUrlResult) => {
        if (err || !data?.Url) return reject(err ?? new Error('生成签名 URL 失败'));
        resolve({ objectKey, url: data.Url, expiresAt: now + expireSeconds });
      },
    );
  });
}

/** 删除 COS 对象 */
export async function deleteObject(objectKey: string): Promise<void> {
  const { bucket, region } = config.cosStorage;
  await getCos().deleteObject({ Bucket: bucket, Region: region, Key: objectKey });
}