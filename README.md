# Ginkgo

A local-first journal, with optional Dropbox sync.

## Templates

A template is starter text for a new entry: an intention line, a fixed set of questions or a daily prompt. Your entry's header (date, location, weather, mood and title) still fills in on its own above the template.

**Using templates**
- **＋** creates an entry from your default template, or a blank entry if you haven't set one.
- **▾** next to ＋ lets you choose a template (or **blank**) for this one entry.
- **☰ → insert template** adds a template to the entry you have open, at your cursor. If the cursor is in the header, it goes at the end of the entry instead.

**Managing templates**
Go to **☰ → templates** to add, edit, rename or delete templates, and to check **use for ＋ (default)** on the one ＋ should use. Uncheck it to make ＋ blank again. Templates are plain markdown, and they sync through Dropbox like your entries.

**Placeholders**

| Write this | You get |
|---|---|
| `{{weekday}}` | Thursday |
| `{{date}}` | November 12, 2026 |
| `{{prompt}}` | A random question from your prompt list |

Placeholders use the entry's own date, so inserting a template into an older entry gives that day's weekday.

**Fixed vs. rotating questions**
- Questions you want every day: type them straight into the template.
- Questions you want to rotate: put them in your prompt list (one per line, under **☰ → templates**) and use `{{prompt}}` in the template. Each `{{prompt}}` picks a different question, and recent ones won't repeat until the list runs out.

```
**Intention:** 

1. What am I grateful for today?
2. What's one thing I want to finish?
3. {{prompt}}
```

**Good to know**
- The entry list's preview skips template lines you haven't filled in, so it shows what you actually wrote.
- Deleting or editing a template never changes entries already made from it.
- Templates sync as one file (`.ginkgo-templates.json`) in your Ginkgo Dropbox folder, encrypted if sync encryption is on. If two devices edit templates before syncing, the most recent edit wins.
