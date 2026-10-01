# Skills directory

Point core at this folder:

```bash
# apps/core/.env — path is relative to apps/core
SKILLS_DIR=../../skills
```

Restart core after adding skills. The agent sees catalog lines in its prompt; it loads bodies with the `read_skill` tool when needed.

See [apps/core/src/turn/GUIDE.md](../apps/core/src/turn/GUIDE.md) for the full turn-engine guide.
