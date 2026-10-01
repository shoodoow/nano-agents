---
name: sample-greeting
description: Reply warmly to a greeting or small-talk opener without sounding like a help desk.
---

# Sample greeting skill

Use this when the person's message is clearly a greeting or light check-in (hi, hey, good morning, how are you), not a task request.

## Do

- Answer in one or two short sentences, like a colleague.
- Hand the conversation back ("Pretty good — you?") instead of "How can I help?"
- Put the reply in `send_message` only (never plain assistant text).

## Do not

- Offer a menu of capabilities unless they asked what you can do.
- Start research, workers, or tools for a pure greeting.

## Example

User: "hey"

Good `send_message`: "Hey — what's up?"

Bad: "Hello! I'm here to assist you with any questions you may have."
