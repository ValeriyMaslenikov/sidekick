# Sidekick

A public collection of agent skills that help a person in daily work with AI agents. The first skill, `punch-list`, lets an agent put its questions on a live web page instead of the terminal.

## Language

### Boards

**Board**:
One named, live web page holding a set of Questions for one topic or task. An agent session may open several.
_Avoid_: Context, session, form, page

**Question**:
One thing the agent needs the person to decide or tell it, shown as a unit on a Board.
_Avoid_: Prompt, item, field

**Answer**:
The person's reply to one Question. It reaches the agent when the person sends it, and can still be changed afterwards.
_Avoid_: Response, submission

**Explain request**:
The person asking the agent to clarify one Question, optionally with their own question about it.
_Avoid_: Help request, clarification

**Explanation**:
Extra material the agent adds to a Question in reply to an Explain request. Explanations on one Question stack.
_Avoid_: Hint, note

**Skipped question**:
A Question the person set aside for later. It stays open and counts as unanswered when the Board is marked done.
_Avoid_: Parked, deferred

**Changed question**:
A Question the agent edited after it was answered. The Answer is kept but the person must confirm or change it.
_Avoid_: Stale, invalidated

**Withdrawn question**:
A Question the agent no longer needs, kept visible with the reason instead of being removed.
_Avoid_: Deleted, cancelled

**Layout**:
How a Board arranges its Questions on screen, such as a list, tabs, a wizard, modals or columns. Chosen by the agent or asked for by the person.
_Avoid_: Template, theme, view

**Event**:
Anything the Board sends back to the agent: an Answer, an Explain request, or the Board being marked done. Requests not tied to a Question go to the agent directly, not through the Board.
_Avoid_: Message, callback, notification

**Listener**:
The agent's standing wait on a Board for its next Event. A Board that is not done should always have one.
_Avoid_: Subscriber, poller, watcher

**Retention**:
How long a Board is kept after it was opened before it is cleaned up. 90 days unless the person configures otherwise.
_Avoid_: TTL, expiry
