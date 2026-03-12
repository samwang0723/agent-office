.PHONY: help server dev lint typecheck ci clean publish

PORT ?= 3456

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

server: clean ## Start the bridge server (PORT=N to override, default 3456)
	@(sleep 1 && open http://localhost:$(PORT)) &
	PORT=$(PORT) bun run src/server.ts

dev: clean ## Start with watch mode (PORT=N to override, default 3456)
	@(sleep 1 && open http://localhost:$(PORT)) &
	PORT=$(PORT) bun --watch run src/server.ts

lint: ## Run linter (Biome)
	bun run lint

typecheck: ## Run TypeScript type checking
	bun run typecheck

ci: ## Run all checks (typecheck + lint)
	bun run ci

clean: ## Remove runtime data (logs, agent state, inboxes)
	rm -rf data/

publish: ## Build and publish to npm (runs ci + build first)
	bun run ci
	bun run build
	npm publish
