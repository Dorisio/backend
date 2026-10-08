.PHONY: help install setup up down logs migrate seed generate dev build test lint type-check format format-check studio clean

COMPOSE ?= docker compose

help:
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "%-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the pinned dependencies
	pnpm install --frozen-lockfile

setup: ## Create local config, start services, migrate, and seed the database
	@test -f .env.local || cp .env.example .env.local
	$(MAKE) up
	$(MAKE) migrate
	$(MAKE) seed

up: ## Start PostgreSQL, Redis, and the development container
	$(COMPOSE) up -d

down: ## Stop local services and remove containers
	$(COMPOSE) down

logs: ## Follow development container logs
	$(COMPOSE) logs -f backend

migrate: ## Apply pending Prisma migrations
	pnpm prisma migrate deploy

seed: ## Seed idempotent roles and permissions
	pnpm db:seed

generate: ## Generate the Prisma client
	pnpm prisma:generate

dev: ## Start the API with the local toolchain
	pnpm dev

build: ## Compile TypeScript
	pnpm build

test: ## Run the test suite once
	pnpm test:run

lint: ## Run ESLint
	pnpm lint

type-check: ## Check TypeScript without emitting files
	pnpm type-check

format: ## Format source files
	pnpm format

format-check: ## Verify formatting without changing files
	pnpm exec prettier --check "src/**/*.{ts,tsx}"

studio: ## Open Prisma Studio
	pnpm prisma:studio

clean: ## Remove generated build output
	rm -rf dist
