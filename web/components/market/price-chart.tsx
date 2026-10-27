"use client";

import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export type PriceChartHandle = {
  setHistory: (points: [tick: number, value: number][]) => void;
  push: (tick: number, value: number) => void;
};

// Ticks are plotted as the chart's "time" and formatted back as tick numbers.
const asTime = (tick: number) => tick as UTCTimestamp;

export function PriceChart({ ref, height = 260 }: { ref: Ref<PriceChartHandle>; height?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lastTick = useRef(-1);

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8b93a7" },
      grid: { vertLines: { color: "#1b2230" }, horzLines: { color: "#1b2230" } },
      rightPriceScale: { borderColor: "#232b3b" },
      timeScale: {
        borderColor: "#232b3b",
        tickMarkFormatter: (time: number) => String(time),
      },
      localization: { timeFormatter: (time: number) => `tick ${time}` },
    });
    seriesRef.current = chart.addSeries(LineSeries, { color: "#f0b429", lineWidth: 2 });
    chartRef.current = chart;
    return () => {
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useImperativeHandle(ref, () => ({
    setHistory(points) {
      seriesRef.current?.setData(points.map(([t, v]) => ({ time: asTime(t), value: v })));
      lastTick.current = points.length ? points[points.length - 1][0] : -1;
      chartRef.current?.timeScale().fitContent();
    },
    push(tick, value) {
      if (tick <= lastTick.current) return;
      seriesRef.current?.update({ time: asTime(tick), value });
      lastTick.current = tick;
    },
  }));

  return <div ref={container} style={{ height }} />;
}
