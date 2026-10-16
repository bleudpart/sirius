"""Deterministic daily-bar indicators. Missing history stays unknown, not zero."""

import math
from statistics import pstdev, stdev


def sma(values, period):
    result = [None] * len(values)
    for index in range(period - 1, len(values)):
        result[index] = sum(values[index - period + 1:index + 1]) / period
    return result


def ema(values, period):
    result = [None] * len(values)
    if len(values) < period:
        return result
    result[period - 1] = sum(values[:period]) / period
    weight = 2 / (period + 1)
    for index in range(period, len(values)):
        result[index] = values[index] * weight + result[index - 1] * (1 - weight)
    return result


def rsi(values, period=14):
    result = [None] * len(values)
    if len(values) <= period:
        return result
    differences = [right - left for left, right in zip(values, values[1:])]
    gain = sum(max(value, 0) for value in differences[:period]) / period
    loss = sum(max(-value, 0) for value in differences[:period]) / period
    for index in range(period, len(values)):
        if index > period:
            difference = differences[index - 1]
            gain = (gain * (period - 1) + max(difference, 0)) / period
            loss = (loss * (period - 1) + max(-difference, 0)) / period
        result[index] = 50.0 if gain == loss == 0 else 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    return result


def rounded(value):
    return round(value, 6) if value is not None and math.isfinite(value) else None


def analyze(bars):
    closes = [bar["close"] for bar in bars]
    if not closes:
        raise ValueError("At least one validated daily bar is required")
    averages = {f"mm{period}": sma(closes, period) for period in (20, 50, 100, 200)}
    oscillator = rsi(closes)
    fast, slow = ema(closes, 12), ema(closes, 26)
    macd = [left - right if left is not None and right is not None else None
            for left, right in zip(fast, slow)]
    available = [value for value in macd if value is not None]
    signal = [None] * (len(closes) - len(available)) + ema(available, 9)
    upper, lower = [None] * len(closes), [None] * len(closes)
    true_ranges = []
    atr = [None] * len(closes)
    for index, bar in enumerate(bars):
        previous = closes[index - 1] if index else bar["close"]
        true_ranges.append(max(bar["high"] - bar["low"], abs(bar["high"] - previous), abs(bar["low"] - previous)))
        if index == 13:
            atr[index] = sum(true_ranges) / 14
        elif index > 13:
            atr[index] = (atr[index - 1] * 13 + true_ranges[-1]) / 14
        if index >= 19:
            deviation = pstdev(closes[index - 19:index + 1])
            upper[index] = averages["mm20"][index] + 2 * deviation
            lower[index] = averages["mm20"][index] - 2 * deviation
    series = []
    for index, bar in enumerate(bars):
        series.append({
            **bar, **{name: rounded(values[index]) for name, values in averages.items()},
            "rsi14": rounded(oscillator[index]), "macd": rounded(macd[index]),
            "macd_signal": rounded(signal[index]),
            "macd_histogram": rounded(macd[index] - signal[index]) if signal[index] is not None else None,
            "bollinger_upper": rounded(upper[index]), "bollinger_lower": rounded(lower[index]),
            "atr14": rounded(atr[index]),
        })
    returns = [math.log(right / left) for left, right in zip(closes[-21:], closes[-20:])] if len(closes) >= 21 else []
    peak, drawdown = closes[0], 0
    for value in closes:
        peak = max(peak, value)
        drawdown = min(drawdown, (value / peak - 1) * 100)
    last = series[-1]
    last_average = last["mm200"]
    trend = "history_insufficient" if last_average is None else (
        "above_mm200" if closes[-1] > last_average else "below_mm200" if closes[-1] < last_average else "on_mm200"
    )
    return {
        "series": series, "latest": last, "trend": trend,
        "volatility_20d_annualized_pct": rounded(stdev(returns) * math.sqrt(252) * 100) if returns else None,
        "max_drawdown_pct": rounded(drawdown),
        "support_20d": min(bar["low"] for bar in bars[-20:]) if len(bars) >= 20 else None,
        "resistance_20d": max(bar["high"] for bar in bars[-20:]) if len(bars) >= 20 else None,
        "volume_average_20d": rounded(sum(bar["volume"] for bar in bars[-20:]) / 20)
        if len(bars) >= 20 and all(bar["volume"] is not None for bar in bars[-20:]) else None,
    }
