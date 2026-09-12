# Giggora — developer workflow (brief §8).
#
# NOTE for Windows: `make` is not installed by default. Every target below is a
# thin wrapper around a script or npm script that you can run directly:
#
#     bash scripts/create-genesis.sh      (make genesis)
#     bash scripts/start-network.sh       (make start)
#     node scripts/verify-network.mjs     (make test)
#     docker compose -p giggora down      (make stop)
#
# ...or use the npm equivalents: npm run genesis / start / stop / verify / clean

.PHONY: monitor backup dapp wallet-test api-regressions help config genesis start stop restart logs status test clean reset setup-contracts contracts contracts-test deploy-contract db-migrate indexer api api-test web-build web web-test

help:
	@echo ""
	@echo "  Giggora"
	@echo "  -------"
	@echo "  make config    Regenerate .env and qbftConfigFile.json from chain.config.json"
	@echo "  make genesis   Generate genesis + validator keys (destroys existing keys)"
	@echo "  make start     Start the devnet"
	@echo "  make stop      Stop the devnet (keeps chain data)"
	@echo "  make restart   Stop then start"
	@echo "  make logs      Follow all node logs"
	@echo "  make status    Show container status and current block"
	@echo "  make test      Run the Phase 2 acceptance test"
	@echo "  make clean     Stop and delete ALL chain data, keys, and genesis"
	@echo "  make reset     clean + genesis + start"
	@echo ""
	@echo "  Contracts:"
	@echo "  make setup-contracts  Install OpenZeppelin + forge-std"
	@echo "  make contracts        Compile contracts"
	@echo "  make contracts-test   Run the Foundry test suite"
	@echo "  make deploy-contract  Deploy samples to the devnet and verify logs"
	@echo ""
	@echo "  Indexer + API:"
	@echo "  make db-migrate       Apply database migrations"
	@echo "  make indexer          Run the indexer (follows the chain head)"
	@echo "  make api              Run the explorer API"
	@echo "  make api-test         Run the API contract tests"
	@echo "  make api-regressions  Run the API regression tests"
	@echo ""
	@echo "  Explorer UI:"
	@echo "  make web-build        Build the explorer UI"
	@echo "  make web              Serve the built explorer UI"
	@echo "  make web-test         Run the explorer UI tests"
	@echo ""
	@echo "  Wallet + DApp:"
	@echo "  make dapp             Serve the sample DApp"
	@echo "  make wallet-test      Run wallet compatibility tests"
	@echo ""
	@echo "  Operations:"
	@echo "  make monitor          Chain health check (exit 0/1/2)"
	@echo "  make backup           Back up genesis, config and schema"
	@echo ""

config:
	node scripts/gen-config.mjs

genesis:
	bash scripts/create-genesis.sh

start:
	bash scripts/start-network.sh

stop:
	docker compose -p giggora down

restart: stop start

logs:
	docker compose -p giggora logs -f

status:
	@docker compose -p giggora ps
	@echo ""
	@curl -s -X POST -H "Content-Type: application/json" \
		--data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
		http://localhost:8545 || echo "  RPC not reachable"
	@echo ""

test:
	node scripts/verify-network.mjs

clean:
	docker compose -p giggora down -v
	rm -rf blockchain/nodes blockchain/genesis/networkFiles blockchain/genesis/genesis.json

reset: clean genesis start

setup-contracts:
	bash scripts/setup-contracts.sh

contracts:
	bash scripts/forge.sh build

contracts-test:
	bash scripts/forge.sh test

deploy-contract:
	node scripts/deploy-contracts.mjs

db-migrate:
	bash scripts/db-migrate.sh

indexer:
	node indexer/src/index.ts

api:
	node explorer-api/src/server.ts

api-test:
	node scripts/test-api.ts

web-build:
	npm --prefix explorer-web run build

web:
	npm --prefix explorer-web run start

web-test:
	node scripts/test-explorer-web.mjs

api-regressions:
	node scripts/test-api-regressions.ts

dapp:
	node dapp/serve.mjs

wallet-test:
	node scripts/test-wallet.mjs

monitor:
	node scripts/monitor-chain.mjs

backup:
	bash scripts/backup.sh

# Whole stack: chain + indexer + API + explorer UI, in containers.
# Behind the "explorer" profile so `docker compose -p giggora up -d` stays chain-only —
# the two explorer images cost ~800 MB and land in a virtual disk that never
# shrinks, so they are opt-in.
stack:
	docker compose -p giggora --profile explorer up -d --build

stack-down:
	docker compose -p giggora --profile explorer down

stack-logs:
	docker compose -p giggora --profile explorer logs -f indexer api web
