import { memo, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  children: string;
}

const MARKDOWN_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS = {
  table({ children, ...props }: ComponentPropsWithoutRef<'table'>) {
    return (
      <div className="w-full overflow-x-auto my-3">
        <table {...props}>{children}</table>
      </div>
    );
  },
};

const MarkdownContent = memo(function MarkdownContent({ children }: MarkdownContentProps) {
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
});

export default MarkdownContent;
