"""Lobby configuration: goods, price-model parameters, bot order flow and exchange rules."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .exchange import ExchangeRules


@dataclass(frozen=True)
class MakerParams:
    """Bot market maker: quotes around a noisy estimate of fair value, widening with volatility."""

    levels: int = 2
    base_half_spread: float = 1.5  # ticks
    vol_spread_mult: float = 0.5  # extra half-spread per unit of per-tick volatility
    level_step: int = 1
    size_min: int = 5
    size_max: int = 15
    quote_noise: float = 0.75  # std (ticks) of the maker's fair-value estimate error


@dataclass(frozen=True)
class NoiseParams:
    """Zero-intelligence traders: Poisson arrivals, exponential limit offsets, geometric sizes."""

    rate: float = 1.5  # expected orders per tick
    take_prob: float = 0.35  # share of orders that cross the spread (IOC)
    take_reach: float = 2.0  # ticks beyond the maker's half-spread a taker will pay
    offset_mean: float = 3.0  # mean distance (ticks) of passive orders from fair value
    size_p: float = 0.25  # geometric parameter, mean size 1/p
    size_max: int = 20
    ttl: int = 20  # ticks a passive noise order rests before expiring


@dataclass(frozen=True)
class InformedParams:
    """Kyle-style informed trader who sees fair value ``horizon`` ticks ahead."""

    prob: float = 0.05  # chance of arriving each tick
    horizon: int = 20
    threshold: float = 4.0  # minimum expected move (ticks) worth trading on
    size_p: float = 0.3
    size_max: int = 10


@dataclass(frozen=True)
class GoodConfig:
    name: str
    model: str  # "ou" | "garch_jump"
    model_params: dict = field(default_factory=dict)
    position_limit: int = 50
    maker: MakerParams = MakerParams()
    noise: NoiseParams = NoiseParams()
    informed: InformedParams = InformedParams()

    @classmethod
    def from_dict(cls, d: dict) -> GoodConfig:
        return cls(
            name=d["name"],
            model=d["model"],
            model_params=dict(d.get("model_params", {})),
            position_limit=d.get("position_limit", 50),
            maker=MakerParams(**d.get("maker", {})),
            noise=NoiseParams(**d.get("noise", {})),
            informed=InformedParams(**d.get("informed", {})),
        )


@dataclass(frozen=True)
class LobbyConfig:
    goods: tuple[GoodConfig, ...]
    tick_ms: int = 1000
    dataset_ticks: int = 10_000  # K: ticks 0..K-1 form the public dataset; live starts at K
    live_ticks: int = 3_600
    depth_levels: int = 10
    max_orders_per_tick: int = 20
    max_open_orders: int = 50
    maker_fee: int = 0
    taker_fee: int = 0

    def rules(self) -> ExchangeRules:
        return ExchangeRules(
            goods=tuple(g.name for g in self.goods),
            position_limits={g.name: g.position_limit for g in self.goods},
            max_orders_per_tick=self.max_orders_per_tick,
            max_open_orders=self.max_open_orders,
            maker_fee=self.maker_fee,
            taker_fee=self.taker_fee,
        )

    def to_dict(self) -> dict:
        d = asdict(self)
        d["goods"] = [asdict(g) for g in self.goods]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> LobbyConfig:
        rest = {k: v for k, v in d.items() if k != "goods"}
        return cls(goods=tuple(GoodConfig.from_dict(g) for g in d["goods"]), **rest)


STABLE = GoodConfig(
    name="STABLE",
    model="ou",
    model_params={"mu": 10_000.0, "kappa": 0.01, "sigma": 1.5},
    position_limit=50,
)

VOLATILE = GoodConfig(
    name="VOLATILE",
    model="garch_jump",
    model_params={
        "s0": 5_000.0,
        "drift": 0.0,
        "omega": 5e-9,
        "alpha": 0.08,
        "beta": 0.90,
        "nu": 4.0,
        "jump_rate": 0.002,
        "jump_mean": 0.0,
        "jump_std": 0.01,
    },
    position_limit=30,
    maker=MakerParams(base_half_spread=1.0, vol_spread_mult=1.0, size_min=3, size_max=10),
    informed=InformedParams(threshold=6.0),
)


PRESETS = {g.name: g for g in (STABLE, VOLATILE)}


def default_lobby_config() -> LobbyConfig:
    return LobbyConfig(goods=(STABLE, VOLATILE))


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        out[key] = _merge(out[key], value) if isinstance(out.get(key), dict) else value
    return out


def resolve_lobby_config(public: dict, model: dict) -> LobbyConfig:
    """Builds a lobby config from the web app's stored settings.

    ``public`` is ``lobbies.public_config`` (goods, timing); ``model`` is
    ``lobby_secrets.model_config``: preset names plus optional per-good overrides, e.g.
    ``{"goods": ["STABLE"], "overrides": {"STABLE": {"model_params": {"kappa": 0.02}}}}``.
    """
    names = model.get("goods") or public.get("goods") or []
    unknown = [n for n in names if n not in PRESETS]
    if unknown or not names:
        raise ValueError(f"unknown or missing goods: {unknown or names}")
    overrides = model.get("overrides", {})
    goods = tuple(
        GoodConfig.from_dict(_merge(asdict(PRESETS[n]), overrides.get(n, {}))) for n in names
    )
    return LobbyConfig(
        goods=goods,
        tick_ms=int(public.get("tick_ms", 1000)),
        dataset_ticks=int(public.get("dataset_ticks", 10_000)),
        live_ticks=int(public.get("live_ticks", 3_600)),
    )
