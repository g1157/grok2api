import json
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from app.core.config import get_config
from app.core.logger import logger

STATE_FILE = Path("data/imagine_sso_state.json")
STATE_FILE.parent.mkdir(parents=True, exist_ok=True)


class SSOState:
    def __init__(self):
        self.usage_count: int = 0
        self.daily_count: int = 0
        self.last_used: float = 0.0
        self.fail_count: int = 0
        self.last_fail: float = 0.0
        self.age_verified: bool = False
        self.last_reset_date: str = ""


class ImagineSSOPool:
    def __init__(self):
        self._states: dict[str, SSOState] = {}
        self._tokens: list[str] = []
        self._index: int = 0
        self._load_state()

    def _get_tokens_from_manager(self) -> list[str]:
        """Sync method - reads from already-initialized token manager pools."""
        try:
            from app.services.token.manager import TokenManager
            mgr = TokenManager._instance
            if mgr is None or not mgr.pools:
                return []
            tokens = []
            for pool in mgr.pools.values():
                for info in pool.list():
                    raw = str(info.token or "").strip()
                    if raw.startswith("sso="):
                        raw = raw[4:]
                    if raw:
                        tokens.append(raw)
            return tokens
        except Exception as e:
            logger.warning(f"Failed to get tokens from manager: {e}")
            return []

    def _load_state(self):
        self._tokens = self._get_tokens_from_manager()
        if STATE_FILE.exists():
            try:
                data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
                for token, s in data.items():
                    state = SSOState()
                    state.usage_count = s.get("usage_count", 0)
                    state.daily_count = s.get("daily_count", 0)
                    state.last_used = s.get("last_used", 0.0)
                    state.fail_count = s.get("fail_count", 0)
                    state.last_fail = s.get("last_fail", 0.0)
                    state.age_verified = s.get("age_verified", False)
                    state.last_reset_date = s.get("last_reset_date", "")
                    self._states[token] = state
            except Exception as e:
                logger.warning(f"Failed to load imagine SSO state: {e}")

        for token in self._tokens:
            if token not in self._states:
                self._states[token] = SSOState()

    def _save_state(self):
        data = {}
        for token, s in self._states.items():
            data[token] = {
                "usage_count": s.usage_count,
                "daily_count": s.daily_count,
                "last_used": s.last_used,
                "fail_count": s.fail_count,
                "last_fail": s.last_fail,
                "age_verified": s.age_verified,
                "last_reset_date": s.last_reset_date,
            }
        try:
            STATE_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning(f"Failed to save imagine SSO state: {e}")

    def _check_daily_reset(self, state: SSOState):
        today = datetime.utcnow().strftime("%Y-%m-%d")
        if state.last_reset_date != today:
            state.daily_count = 0
            state.last_reset_date = today

    def get_next_sso(self, strategy: str = "hybrid") -> Optional[str]:
        if not self._tokens:
            return None

        daily_limit = get_config("imagine.sso_daily_limit", 10)
        available = []
        for token in self._tokens:
            state = self._states.get(token, SSOState())
            self._check_daily_reset(state)
            if state.daily_count < daily_limit and state.fail_count < 5:
                available.append(token)

        if not available:
            return None

        if strategy == "round_robin":
            self._index = self._index % len(available)
            token = available[self._index]
            self._index += 1
            return token
        elif strategy == "least_used":
            return min(available, key=lambda t: self._states.get(t, SSOState()).usage_count)
        elif strategy == "least_recent":
            return min(available, key=lambda t: self._states.get(t, SSOState()).last_used)
        elif strategy == "weighted":
            return min(available, key=lambda t: self._states.get(t, SSOState()).daily_count)
        else:  # hybrid
            return min(available, key=lambda t: (
                self._states.get(t, SSOState()).daily_count * 10
                + self._states.get(t, SSOState()).fail_count * 100
                - (1.0 / (time.time() - self._states.get(t, SSOState()).last_used + 1))
            ))

    def record_usage(self, token: str):
        state = self._states.setdefault(token, SSOState())
        self._check_daily_reset(state)
        state.usage_count += 1
        state.daily_count += 1
        state.last_used = time.time()
        self._save_state()

    def mark_failed(self, token: str):
        state = self._states.setdefault(token, SSOState())
        state.fail_count += 1
        state.last_fail = time.time()
        self._save_state()

    def mark_success(self, token: str):
        state = self._states.setdefault(token, SSOState())
        state.fail_count = 0
        self._save_state()

    def get_status(self) -> dict:
        daily_limit = get_config("imagine.sso_daily_limit", 10)
        tokens_status = []
        for token in self._tokens:
            state = self._states.get(token, SSOState())
            self._check_daily_reset(state)
            masked = token[:8] + "..." + token[-4:] if len(token) > 12 else "***"
            tokens_status.append({
                "token": masked,
                "usage_count": state.usage_count,
                "daily_count": state.daily_count,
                "daily_limit": daily_limit,
                "fail_count": state.fail_count,
                "age_verified": state.age_verified,
                "available": state.daily_count < daily_limit and state.fail_count < 5,
            })
        return {
            "total": len(self._tokens),
            "available": sum(1 for t in tokens_status if t["available"]),
            "tokens": tokens_status,
        }

    def reload(self):
        self._tokens = self._get_tokens_from_manager()
        for token in self._tokens:
            if token not in self._states:
                self._states[token] = SSOState()
        self._save_state()

    def reset_daily_usage(self):
        for state in self._states.values():
            state.daily_count = 0
            state.last_reset_date = datetime.utcnow().strftime("%Y-%m-%d")
        self._save_state()

    def get_age_verified(self, token: str) -> bool:
        state = self._states.get(token)
        return state.age_verified if state else False

    def set_age_verified(self, token: str, verified: bool = True):
        state = self._states.setdefault(token, SSOState())
        state.age_verified = verified
        self._save_state()


_pool: Optional[ImagineSSOPool] = None


def get_imagine_sso_pool() -> ImagineSSOPool:
    global _pool
    if _pool is None:
        _pool = ImagineSSOPool()
    return _pool
