# Giggora — developer workflow (brief §8).
#
# NOTE for Windows: `make` is not installed by default. Every target below is a
# thin wrapper around a script or npm script that you can run directly:
#
#     bash scripts/create-genesis.sh      (make genesis)
#     bash scripts/start-network.sh       (make start)
#     node scripts/verify-network.mjs     (make test)
#     docker compose down                 (make stop)
#
# ...or use the npm equivalents: npm run genesis / start / stop / verify / clean

.PHONY: help config genesis start stop restart logs status test clean reset

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

config:
	node scripts/gen-config.mjs

genesis:
	bash scripts/create-genesis.sh

start:
	bash scripts/start-network.sh

stop:
	docker compose down

restart: stop start

logs:
	docker compose logs -f

status:
	@docker compose ps
	@echo ""
	@curl -s -X POST -H "Content-Type: application/json" \
		--data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
		http://localhost:8545 || echo "  RPC not reachable"
	@echo ""

test:
	node scripts/verify-network.mjs

clean:
	docker compose down -v
	rm -rf blockchain/nodes blockchain/genesis/networkFiles blockchain/genesis/genesis.json

reset: clean genesis start
