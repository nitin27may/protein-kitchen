"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders technique cards. Tables scroll sideways on a narrow screen. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-3 text-base leading-relaxed [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ul]:list-disc [&_ul]:space-y-1 [&_strong]:font-semibold">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: (props) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...props} />
            </div>
          ),
          th: (props) => <th className="border-b border-line p-2 text-left font-semibold" {...props} />,
          td: (props) => <td className="border-b border-line p-2" {...props} />,
          a: (props) => <a className="font-semibold text-primary underline" target="_blank" rel="noreferrer" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
