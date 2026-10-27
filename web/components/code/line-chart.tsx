"use client";

import { createChart, LineSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

/** Static line chart over ticks (x) — used for backtest PnL. */
export function LineChart({
  points,
  color = "#22c55e",
  height = 200,
}: {
  points: [tick: number, value: number][];
  color?: string;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8b93a7" },
      grid: { vertLines: { color: "#1b2230" }, horzLines: { color: "#1b2230" } },
      rightPriceScale: { borderColor: "#232b3b" },
      timeScale: { borderColor: "#232b3b", tickMarkFormatter: (t: number) => String(t) },
      localization: { timeFormatter: (t: number) => `tick ${t}` },
    });
    seriesRef.current = chart.addSeries(LineSeries, { color, lineWidth: 2 });
    chartRef.current = chart;
    return () => {
      seriesRef.current = null;
      chart.remove();
    };
  }, [color]);

  useEffect(() => {
    seriesRef.current?.setData(points.map(([t, v]) => ({ time: t as UTCTimestamp, value: v })));
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={container} style={{ height }} />;
}
