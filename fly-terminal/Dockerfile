FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ttyd bash git curl wget ca-certificates vim nano htop \
    python3 python3-pip nodejs npm \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /root

EXPOSE 8080

# Terminal web protégé par identifiant et mot de passe (variables de Fly).
# -W autorise la saisie. Le shell tourne en root, à l'intérieur du conteneur uniquement.
CMD ["sh", "-c", "exec ttyd -p 8080 -W -c \"$TERMINAL_USER:$TERMINAL_PASSWORD\" bash"]
