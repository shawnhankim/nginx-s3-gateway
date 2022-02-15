.PHONY: start watch down clean clean-cache unit-test functional-test test
.DEFAULT_GOAL := help

start:
	docker-compose up -d

ps:
	docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Names}}"

watch:
	watch 'docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Names}}"'

down:
	docker-compose down

clean: 
	docker kill $$(docker ps -q) 2> /dev/null || true
	docker system prune -a
	docker volume rm $(docker volume ls -qf dangling=true)

clean-cache:
	find . -type d -name __pycache__ -exec rm -r {} \+
	find . -type d -name .cache -exec rm -r {} \+
	find . -type d -name .pytest_cache -exec rm -r {} \+
