# The Ansible that deploy.sh and test.sh run, so the machine they run from needs only Docker (as the Go build does).
FROM python:3.13-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir ansible-core==2.19.3 ansible-lint==25.9.2 docker==7.1.0 \
 && ansible-galaxy collection install -p /usr/share/ansible/collections \
      ansible.posix:2.1.0 community.general:11.4.0 community.docker:4.8.1
ENV ANSIBLE_HOME=/tmp/ansible ANSIBLE_LOCAL_TEMP=/tmp/ansible/tmp ANSIBLE_SSH_CONTROL_PATH_DIR=/tmp/ansible/cp
