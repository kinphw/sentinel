-- Sentinel DB 초기화 스크립트
-- root 또는 DB 관리자 권한으로 실행하세요.

CREATE DATABASE IF NOT EXISTS sentinel_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON sentinel_db.* TO 'ldbuser'@'localhost';
FLUSH PRIVILEGES;

USE sentinel_db;

CREATE TABLE IF NOT EXISTS issues (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  input_text    LONGTEXT     NOT NULL,
  status        ENUM('OPEN','IN_PROGRESS','WAITING_CONFIRM','COMPLETED','FAILED')
                NOT NULL DEFAULT 'OPEN',
  current_stage ENUM('STAGE_1','STAGE_2','STAGE_3') NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stage_sessions (
  id                    VARCHAR(36) NOT NULL PRIMARY KEY,
  issue_id              VARCHAR(36) NOT NULL,
  stage                 ENUM('STAGE_1','STAGE_2','STAGE_3') NOT NULL,
  status                ENUM('READY','RUNNING','WAITING_FOR_HUMAN','CONFIRMED','SUPERSEDED','FAILED')
                        NOT NULL DEFAULT 'READY',
  input_artifact_id     VARCHAR(36) NULL,
  latest_artifact_id    VARCHAR(36) NULL,
  confirmed_artifact_id VARCHAR(36) NULL,
  retry_count           INT         NOT NULL DEFAULT 0,
  last_feedback_at      DATETIME    NULL,
  created_at            DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_issue (issue_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS agent_runs (
  id               VARCHAR(36)  NOT NULL PRIMARY KEY,
  stage_session_id VARCHAR(36)  NOT NULL,
  status           ENUM('QUEUED','RUNNING','PAUSED_FOR_TOOL','PAUSED_FOR_HUMAN','COMPLETED','FAILED')
                   NOT NULL DEFAULT 'QUEUED',
  model            VARCHAR(100) NOT NULL,
  started_at       DATETIME     NULL,
  ended_at         DATETIME     NULL,
  stop_reason      ENUM('tool','human','completed','error') NULL,
  INDEX idx_session (stage_session_id),
  FOREIGN KEY (stage_session_id) REFERENCES stage_sessions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS artifacts (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  stage_session_id VARCHAR(36) NOT NULL,
  version          INT         NOT NULL DEFAULT 1,
  status           ENUM('draft','confirmed','superseded') NOT NULL DEFAULT 'draft',
  content          LONGTEXT    NOT NULL,
  summary          TEXT        NULL,
  created_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session (stage_session_id),
  FOREIGN KEY (stage_session_id) REFERENCES stage_sessions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS feedbacks (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  stage_session_id VARCHAR(36) NOT NULL,
  author_type      ENUM('user','reviewer') NOT NULL DEFAULT 'user',
  content          TEXT        NOT NULL,
  created_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session (stage_session_id),
  FOREIGN KEY (stage_session_id) REFERENCES stage_sessions(id)
) ENGINE=InnoDB;

-- api_message: Anthropic API 메시지 형식 JSON 직렬화. 대화 재구성에 사용됨.
CREATE TABLE IF NOT EXISTS messages (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  stage_session_id VARCHAR(36) NOT NULL,
  agent_run_id     VARCHAR(36) NULL,
  role             ENUM('system','user','assistant') NOT NULL,
  api_message      LONGTEXT    NOT NULL,
  created_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session (stage_session_id),
  FOREIGN KEY (stage_session_id) REFERENCES stage_sessions(id)
) ENGINE=InnoDB;
