.PHONY: help server dev clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

server: ## Start the bridge server
	bun run src/server.ts

dev: ## Start the bridge server with watch mode (auto-restart on changes)
	bun --watch run src/server.ts

clean: ## Remove runtime data (logs, agent state, inboxes)
	rm -rf data/
