"use client";

// A small, dependency-free emoji picker: a curated grid of what a factory
// team actually sends, not a 3000-glyph catalog. Native emoji rendering —
// nothing to load.

const GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "Faces",
    emojis: [
      "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤩", "🥳",
      "😉", "🙃", "😅", "😇", "🤔", "🤨", "😐", "😴", "🥱", "😮",
      "😢", "😭", "😤", "😡", "🥵", "🥶", "😱", "🤯", "🤒", "🤕",
    ],
  },
  {
    label: "Hands",
    emojis: [
      "👍", "👎", "👌", "✌️", "🤞", "💪", "👏", "🙌", "🤝", "🙏",
      "👉", "👈", "👆", "👇", "✋", "🖐️", "👊", "🤙", "💅", "🫡",
    ],
  },
  {
    label: "Work",
    emojis: [
      "🔥", "⚡", "✅", "❌", "⚠️", "🚨", "⏰", "📌", "📦", "📋",
      "🔧", "🔨", "⚙️", "🏭", "🚚", "📸", "📄", "📊", "💡", "🎯",
      "🕐", "📅", "✏️", "🔍", "🧰", "🪫", "🔋", "🛠️", "⛔", "🚀",
    ],
  },
  {
    label: "Hearts",
    emojis: ["❤️", "🧡", "💚", "💙", "💜", "🖤", "💔", "❣️", "💯", "✨"],
  },
];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="max-h-56 overflow-y-auto p-2">
      {GROUPS.map((g) => (
        <div key={g.label}>
          <p className="px-1 pt-1.5 pb-0.5 text-[10px] font-extrabold uppercase tracking-wider text-muted">{g.label}</p>
          <div className="grid grid-cols-8 sm:grid-cols-10">
            {g.emojis.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => onPick(e)}
                className="grid place-items-center w-8 h-8 rounded-lg text-lg hover:bg-surface-2 transition-colors"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The quick-reaction row shown on a message's menu. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
