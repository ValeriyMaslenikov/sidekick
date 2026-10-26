# Board format

`open` takes a Board; `push` takes a patch with any of the same top-level fields. Questions in a patch are upserted by `id` (new ids are added at the end).

```json
{
  "title": "How should I fix the dev/stg log errors?",
  "intro": "<p>Five causes produce ~99% of the errors. Nothing has changed yet.</p>",
  "layout": { "type": "tabs", "groups": [{ "id": "data", "title": "Data fixes" }, { "id": "code", "title": "Code" }] },
  "questions": [
    {
      "id": "outbox_rows",
      "group": "data",
      "title": "Delete the 7 dead outbox rows?",
      "body": "<p>They are retried every 2 minutes forever.</p><pre class=\"mermaid\">flowchart LR; Row-->Retry-->Fail-->Row</pre>",
      "type": "single",
      "options": [
        { "value": "delete", "label": "Delete them now", "detail": "Plain <code>DELETE</code> in each DB.", "recommended": true },
        { "value": "sql", "label": "Give me the SQL" },
        { "value": "skip", "label": "Leave them" }
      ]
    },
    { "id": "cap", "group": "code", "title": "Also cap retries in code?", "type": "yes-no" },
    { "id": "cap_n", "group": "code", "title": "Max attempts?", "type": "number", "min": 1, "max": 1000, "showIf": { "cap": "yes" } }
  ]
}
```

## Question fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Letters, digits, `_`, `-`; unique on the Board. |
| `title` | yes | The question, one line. |
| `type` | yes | `yes-no`, `single`, `multi`, `text`, `number`, `scale`, `rank`, `custom`. |
| `body` | no | HTML under the title. Scripts run; CDN libraries load (`<script src="https://cdn.jsdelivr.net/npm/...">`). Mermaid: `<pre class="mermaid">`. |
| `options` | for `single`, `multi`, `rank` | `[{value, label, detail?, recommended?}]`; `label` and `detail` may contain HTML. |
| `min`, `max`, `step` | no | For `number` and `scale` (scale defaults to 1–5). |
| `showIf` | no | `{ "<questionId>": "<value>" or ["v1", "v2"] }`; shown only when every listed Answer matches (for `multi`, any chosen value). |
| `optional` | no | Informational flag shown to the person. |
| `group` | no | A `layout.groups` id: the tab, wizard step or column it belongs to. |

Answer values sent back: `yes-no` → `"yes"`/`"no"`, `single` → option value, `multi` → array of values, `text` → string, `number`/`scale` → number, `rank` → array of values in order, `custom` → whatever the page code passed to `punchList.answer`.

## Layouts

| `layout.type` | Shows |
|---|---|
| `list` (default) | All Questions in one column; sections per group when `groups` is set. |
| `tabs` | A tab per group (or per Question when no groups), with an open-count badge. |
| `wizard` | One group (or Question) per step with Back/Next and progress. |
| `columns` | Jira-like columns of compact tiles; click a tile to open the full Question. One column per group, or per status (`Open`, `Skipped`, `Answered`) when there are no groups or `"columnsBy": "status"`. |
| `custom` | Your own `html`; each `<div data-pl-question="<id>"></div>` receives that Question's card. Unplaced Questions are listed below it. Optional `script` runs after mounting with `punchList` in scope. |

Every Layout keeps the same page controls: the listening indicator, "Send to Claude", Done, and the "Expand" view of any Question.

## `punchList` page API (custom layouts and `custom` Questions)

```js
punchList.answer(qid, value)      // set an Answer (saved, sent on "Send to Claude")
punchList.note(qid, text)
punchList.explain(qid, text)      // same as the "Explain better" button
punchList.skip(qid, true|false)
punchList.open(qid)               // show the Question in the large view
punchList.state()                 // { title, layout, questions, answers, listening, done, ... }
punchList.on('state' | 'answer', fn)  // returns an unsubscribe function
punchList.renderQuestion(qid, element)
```

## Events printed by `wait`

```json
[
  { "seq": 3, "at": "2026-10-26T12:00:00Z", "type": "explain", "data": { "qid": "cap", "title": "Also cap retries in code?", "text": "what's a cap?" } },
  { "seq": 4, "at": "…", "type": "answers", "data": { "answers": [{ "qid": "outbox_rows", "title": "…", "value": "delete", "note": "do dev first" }] } },
  { "seq": 5, "at": "…", "type": "done", "data": { "answered": ["outbox_rows"], "skipped": [], "unanswered": ["cap"] } }
]
```
