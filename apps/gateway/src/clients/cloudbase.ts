/**
 * 腾讯云 CloudBase 文件存储客户端（网关后端中转上传）
 * 实测接口（2026-09-10，控制台环境 study-d8g7q568u1e1e4520）：
 * - uploadFile({ cloudPath, fileContent }) → { fileID }
 * - getTempFileURL({ fileList }) → { fileList: [{ fileID, code, tempFileURL, download_url }] }
 * - 文件可公开访问 URL = `${config.cloudbase.publicDomain}/${cloudPath}`
 */
import cloudbase, {
  type CloudBase,
  type IGetFileUrlResult,
  type IUploadFileResult,
} from '@cloudbase/node-sdk';
import { config } from '../config.js';

let app: CloudBase | null = null;

/** 惰性初始化单一实例（凭证缺失时抛出，调用方按 enabled 判断是否走 CloudBase） */
function getApp(): CloudBase {
  if (app) return app;
  const { envId, secretId, secretKey, region } = config.cloudbase;
  app = cloudbase.init({ env: envId, secretId, secretKey, region });
  return app;
}

/** CloudBase 是否已启用且配置完整 */
export function cloudbaseEnabled(): boolean {
  return (
    config.cloudbase.enabled &&
    !!(config.cloudbase.envId && config.cloudbase.secretId && config.cloudbase.secretKey)
  );
}

export interface UploadedFile {
  /** 云存储 fileID，如 cloud://env.xxx/temp-probe/a.txt */
  fileID: string;
  /** 公网可访问 CDN URL */
  url: string;
}

/**
 * 上传 Buffer 到 CloudBase 云存储，返回 fileID 与可访问 URL。
 * cloudPath 需带目录（如 `kb/{yyyy-MM}/{uuid}.{ext}`），避免文件名冲突并利于分目录管理。
 */
export async function uploadToCloudbase(cloudPath: string, fileContent: Buffer): Promise<UploadedFile> {
  const result: IUploadFileResult = await getApp().uploadFile({ cloudPath, fileContent });
  const url = `${config.cloudbase.publicDomain}/${cloudPath}`;
  return { fileID: result.fileID, url };
}

/** 获取文件的临时访问 URL 列表（CDN 域名未配置时的兜底） */
export async function getTempFileURLs(fileIDs: string[]): Promise<string[]> {
  const res: IGetFileUrlResult = await getApp().getTempFileURL({ fileList: fileIDs });
  return (res.fileList ?? [])
    .filter((f) => f.code === 'SUCCESS')
    .map((f) => f.tempFileURL)
    .filter((u): u is string => Boolean(u));
}