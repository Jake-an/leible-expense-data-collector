"""Typed containers for the shopSpend external API response.

Every `from_dict` classmethod only pulls the fields it declares and silently
drops anything else — the server may add keys additively (see
docs/ARCHITECTURE.md shopSpend flow) and that must never raise here.
"""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from typing import Any


def _known_kwargs(cls: type, data: dict[str, Any] | None) -> dict[str, Any]:
    names = {f.name for f in fields(cls)}
    return {k: v for k, v in (data or {}).items() if k in names}


@dataclass
class Paging:
    limit: int = 0
    offset: int = 0
    matched: int = 0
    returned: int = 0
    rowsIncluded: bool = True
    truncated: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Paging:
        return cls(**_known_kwargs(cls, data))


@dataclass
class Meta:
    environment: str = ""
    timezone: str = ""
    gstTreatment: str = ""
    scope: str = ""
    paging: Paging | None = None
    unknownParams: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Meta:
        kwargs = _known_kwargs(cls, data)
        if isinstance(kwargs.get("paging"), dict):
            kwargs["paging"] = Paging.from_dict(kwargs["paging"])
        return cls(**kwargs)


@dataclass
class ShopSpendRow:
    shopId: str = ""
    weekLabel: str = ""
    weekStart: str = ""
    weekEnd: str = ""
    orderCount: int = 0
    amendedCount: int = 0
    totalExGst: float = 0.0
    gst: float = 0.0
    totalIncGst: float = 0.0

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> ShopSpendRow:
        return cls(**_known_kwargs(cls, data))


@dataclass
class Summary:
    shopCount: int = 0
    weekCount: int = 0
    orderCount: int = 0
    amendedCount: int = 0
    grandTotalExGst: float = 0.0
    grandTotalGst: float = 0.0
    grandTotalIncGst: float = 0.0
    byShop: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Summary:
        return cls(**_known_kwargs(cls, data))


@dataclass
class Diagnostics:
    warnings: list = field(default_factory=list)
    pricingBasis: dict | None = None
    emptyRangeWithInvalidLabels: bool = False
    gstBasisMismatch: int = 0
    unpricedSkus: list = field(default_factory=list)
    invalidWeekLabels: int = 0
    invalidWeekLabelSamples: list = field(default_factory=list)
    possibleDuplicateShopNames: list = field(default_factory=list)
    multiBucketWeeks: int = 0
    multiBucketWeekSamples: list = field(default_factory=list)
    totalOrdersScanned: int = 0
    positiveControlCount: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Diagnostics:
        return cls(**_known_kwargs(cls, data))


@dataclass
class ShopSpendResponse:
    rows: list[ShopSpendRow]
    meta: Meta
    summary: Summary | None = None
    diagnostics: Diagnostics | None = None
    schemaVersion: int | None = None
