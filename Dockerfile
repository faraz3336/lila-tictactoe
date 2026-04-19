FROM heroiclabs/nakama:3.20.0

COPY data/modules /nakama/data/modules
COPY deploy/start-nakama.sh /nakama/start-nakama.sh

RUN chmod +x /nakama/start-nakama.sh

CMD ["/nakama/start-nakama.sh"]
