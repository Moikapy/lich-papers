import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor as TiptapEditor } from "@tiptap/react";
import { Extension, type Range } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Mathematics } from "@tiptap/extension-mathematics";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { CodeCell } from "../notebook/CodeCell";
import type { Kernel } from "../notebook/kernel";
import "katex/dist/katex.min.css";

export interface SlashItem {
  title: string;
  hint: string;
  keywords: string;
  run: (editor: TiptapEditor, range: Range) => void;
}

const editLatex = (current: string) => window.prompt("LaTeX", current);

export const SLASH_ITEMS: SlashItem[] = [
  { title: "Text", hint: "Plain paragraph", keywords: "paragraph p", run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { title: "Heading 1", hint: "#", keywords: "h1 title", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { title: "Heading 2", hint: "##", keywords: "h2 subtitle", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { title: "Heading 3", hint: "###", keywords: "h3", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { title: "Bulleted list", hint: "-", keywords: "ul bullet unordered", run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: "Numbered list", hint: "1.", keywords: "ol ordered number", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: "To-do list", hint: "[ ]", keywords: "todo task checkbox", run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: "Quote", hint: ">", keywords: "blockquote", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: "Python cell", hint: "run", keywords: "code notebook jupyter py run cell", run: (e, r) => e.chain().focus().deleteRange(r).insertCodeCell({ language: "python" }).run() },
  { title: "JavaScript cell", hint: "run", keywords: "code notebook js run cell", run: (e, r) => e.chain().focus().deleteRange(r).insertCodeCell({ language: "javascript" }).run() },
  { title: "TypeScript cell", hint: "run", keywords: "code notebook ts run cell", run: (e, r) => e.chain().focus().deleteRange(r).insertCodeCell({ language: "typescript" }).run() },
  { title: "Code block", hint: "```", keywords: "code pre snippet", run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { title: "Divider", hint: "---", keywords: "hr rule separator", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  {
    title: "Math block",
    hint: "$$$…$$$",
    keywords: "latex equation formula",
    run: (e, r) => {
      const latex = editLatex("E = mc^2");
      if (latex) e.chain().focus().deleteRange(r).insertBlockMath({ latex }).run();
    },
  },
  {
    title: "Inline math",
    hint: "$$…$$",
    keywords: "latex equation formula",
    run: (e, r) => {
      const latex = editLatex("x^2");
      if (latex) e.chain().focus().deleteRange(r).insertInlineMath({ latex }).run();
    },
  },
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((i) => `${i.title} ${i.keywords}`.toLowerCase().includes(q));
}

type MenuState = { items: SlashItem[]; index: number; rect: DOMRect | null; command: (item: SlashItem) => void } | null;

/** The "/" command menu: a TipTap suggestion that hands its state to React through `menu`. */
function slashCommand(menu: { get: () => MenuState; set: (m: MenuState) => void }) {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: "/",
          items: ({ query }) => filterSlashItems(query),
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => ({
            onStart: (p: SuggestionProps<SlashItem>) => menu.set({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, command: p.command }),
            onUpdate: (p: SuggestionProps<SlashItem>) => {
              const index = Math.min(menu.get()?.index ?? 0, Math.max(0, p.items.length - 1));
              menu.set({ items: p.items, index, rect: p.clientRect?.() ?? null, command: p.command });
            },
            onExit: () => menu.set(null),
            onKeyDown: ({ event }) => {
              const m = menu.get();
              if (event.key === "Escape") {
                menu.set(null);
                return true;
              }
              if (!m || !m.items.length) return false;
              if (event.key === "ArrowDown") return menu.set({ ...m, index: (m.index + 1) % m.items.length }), true;
              if (event.key === "ArrowUp") return menu.set({ ...m, index: (m.index - 1 + m.items.length) % m.items.length }), true;
              if (event.key === "Enter") {
                const item = m.items[m.index];
                if (item) m.command(item);
                return true;
              }
              return false;
            },
          }),
        }),
      ];
    },
  });
}

export interface EditorProps {
  /** TipTap JSON, an HTML string (imported pages), or null for an empty page. */
  initial: unknown;
  onChange: (doc: unknown, text: string) => void;
  autofocus?: boolean;
  /** Runs this page's code cells. */
  kernel?: Kernel | null;
}

export function PageEditor({ initial, onChange, autofocus, kernel }: EditorProps) {
  const kernelRef = useRef<Kernel | null>(null);
  kernelRef.current = kernel ?? null;
  const [menu, setMenuState] = useState<MenuState>(null);
  const menuRef = useRef<MenuState>(null);
  const [menuStore] = useState(() => ({
    get: () => menuRef.current,
    set: (m: MenuState) => {
      menuRef.current = m;
      setMenuState(m);
    },
  }));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === "heading" ? "Heading" : "Type '/' for commands…") }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Mathematics.configure({
        katexOptions: { throwOnError: false },
        blockOptions: {
          onClick: (node, pos) => {
            const latex = editLatex(node.attrs.latex);
            if (latex !== null) editor?.chain().setNodeSelection(pos).updateBlockMath({ latex }).focus().run();
          },
        },
        inlineOptions: {
          onClick: (node, pos) => {
            const latex = editLatex(node.attrs.latex);
            if (latex !== null) editor?.chain().setNodeSelection(pos).updateInlineMath({ latex }).focus().run();
          },
        },
      }),
      slashCommand(menuStore),
      CodeCell.configure({ getKernel: () => kernelRef.current }),
    ],
    content: (initial as never) ?? "",
    autofocus: autofocus ? "end" : false,
    editorProps: { attributes: { class: "page-doc", "aria-label": "Page content" } },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getJSON(), editor.getText({ blockSeparator: "\n" })),
  });

  // An imported page arrives as HTML; save it once as JSON so it's stored in the editor's own format.
  useEffect(() => {
    if (editor && typeof initial === "string" && initial) onChangeRef.current(editor.getJSON(), editor.getText({ blockSeparator: "\n" }));
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <EditorContent editor={editor} />
      {menu && menu.items.length > 0 && menu.rect && (
        <ul className="slash-menu" role="listbox" style={{ top: menu.rect.bottom + window.scrollY + 6, left: menu.rect.left + window.scrollX }}>
          {menu.items.map((item, i) => (
            <li key={item.title} role="option" aria-selected={i === menu.index}>
              <button
                type="button"
                className={i === menu.index ? "on" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  menu.command(item);
                }}
              >
                <span>{item.title}</span>
                <span className="muted small">{item.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
