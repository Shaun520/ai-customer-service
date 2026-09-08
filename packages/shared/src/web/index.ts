// @aics/shared/web —— 前端共享模块（web 与 admin 两个浏览器应用共用）
// 注意：此子路径仅由浏览器端引入；@aics/shared 主入口保持纯类型，避免污染 Node 网关构建。
export { default as Icon } from './icon';
export { request, DEFAULT_ADMIN_TOKEN } from './request';