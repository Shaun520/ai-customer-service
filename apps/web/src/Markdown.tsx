import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/**
 * AI 回复的 Markdown 渲染组件。
 * - react-markdown：标准 Markdown 渲染（默认不渲染原始 HTML，防注入）
 * - remark-gfm：GFM 扩展（表格、删除线、任务列表、自动链接）
 * - remark-breaks：单换行渲染为 <br>，保留 LLM 输出的换行习惯
 * memo 包裹：流式追加时避免非相关部分重渲染。
 */
export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
    </div>
  );
});