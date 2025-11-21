import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { RefreshCcw, Loader2 } from 'lucide-react';

// --- Configuration ---
const PROXY_BASE = 'https://corsproxy.io/?url=';
const DATA_BASE = 'https://bfcm-2025-data-viz.shiphero.com/sh_metrics/metrics/';

const TIME_RANGES = [
  { label: 'LAST 24 HOURS', days: 1 },
  { label: 'LAST 3 DAYS', days: 3 },
  { label: 'LAST 7 DAYS', days: 7 },
  { label: 'LAST 2 WEEKS', days: 14 },
  { label: 'LAST 4 WEEKS', days: 28 },
];

/**
 * Constructs the final, encoded URL for the CORS proxy.
 */
const getProxyUrl = (path) => {
  const targetUrl = DATA_BASE + path;
  return `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
};

// Define all files
const ALL_CSV_FILES = [
  { url: getProxyUrl('orders.csv'), key: 'orders', name: 'Orders' },
  { url: getProxyUrl('shipping_labels.csv'), key: 'labels', name: 'Shipping Labels' },
  { url: getProxyUrl('total_packers.csv'), key: 'packers', name: 'Total Packers' },
  { url: getProxyUrl('total_pickers.csv'), key: 'pickers', name: 'Total Pickers' },
];

// Split files into two groups for separate charts
const GROUP_A_FILES = ALL_CSV_FILES.slice(0, 2); // Orders, Labels
const GROUP_B_FILES = ALL_CSV_FILES.slice(2);     // Packers, Pickers

// Define colors for the lines (Terminal Theme)
const COLORS = {
  orders: '#f87171',     // Light Red
  labels: '#60a5fa',     // Light Blue
  packers: '#fbbf24',    // Amber
  pickers: '#a78bfa',    // Violet
};

// --- Utility Functions ---

/**
 * A simple, robust CSV parser that relies on column index (0=Time, 1=Value).
 */
const parseCSV = (csvText) => {
  if (!csvText) return [];
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  // Skip header row (slice 1)
  return lines.slice(1).map(line => {
    const parts = line.split(','); 
    if (parts.length < 2) return { timestamp: '', value: 0 };
    
    // Clean up quotes if present
    const timestampStr = parts[0].replace(/"/g, '').trim();
    const valueStr = parts[1].replace(/"/g, '').trim();
    
    const value = parseInt(valueStr, 10);
    return { timestamp: timestampStr, value: isNaN(value) ? 0 : value };
  }).filter(item => item.timestamp !== '');
};

/**
 * Formats a timestamp string to "MMM-DD HH:00" (e.g., "Oct-21 13:00").
 */
const getHourlyKey = (timestampStr) => {
  const date = new Date(timestampStr);
  if (isNaN(date)) return null;

  // Rounds down to nearest hour
  date.setMinutes(0, 0, 0, 0);

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthName = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, '0');
  const hour = date.getHours().toString().padStart(2, '0');

  return {
    hour: `${monthName}-${day} ${hour}:00`,
    sortTime: date.getTime()
  };
};

// Function with exponential backoff for retries
const fetchWithRetry = async (url, name, retries = 3) => {
    let delay = 1000;
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
            }
            return await res.text();
        } catch (error) {
            console.warn(`Fetch attempt ${i + 1} for ${name} failed. Retrying...`);
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
};

// --- UI Components ---

const TimeRangeSelector = ({ selectedRange, onSelectRange }) => (
  <div className="flex flex-wrap justify-center gap-2 mb-8">
    {TIME_RANGES.map((range) => (
      <button
        key={range.label}
        onClick={() => onSelectRange(range.days)}
        className={`px-4 py-2 rounded-md font-mono text-sm font-bold transition-all duration-200 border ${
          selectedRange === range.days
            ? 'bg-green-900 border-green-500 text-green-300 shadow-[0_0_15px_rgba(52,211,153,0.4)] scale-105'
            : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-green-500 hover:text-green-400'
        }`}
      >
        [{range.label}]
      </button>
    ))}
  </div>
);

const SummaryCard = ({ title, value, unit, description, colorClass }) => (
  <div className="bg-gray-800 p-5 rounded-lg border border-green-700 shadow-[0_0_10px_rgba(52,211,153,0.3)] h-full">
    <p className="text-sm font-medium text-green-400">{title}</p>
    <div className="text-2xl sm:text-3xl font-bold text-cyan-400 my-1">
      {value} <span className="text-lg font-semibold text-green-500">{unit}</span>
    </div>
    <p className="text-xs text-green-600 mt-2 leading-relaxed">{description}</p>
  </div>
);

const SummaryWidget = ({ data }) => {
  const aggregates = useMemo(() => {
    const defaults = { count: 0, min: 0, max: 0, avg: 0 };
    
    if (!data || data.length === 0) {
      return { 
        maxDailyOrders: { count: 0, date: 'N/A' }, 
        maxDailyLabels: { count: 0, date: 'N/A' },
        labelsPerLabor: { ...defaults },
        ordersStats: { ...defaults },
        labelsStats: { ...defaults },
        laborStats: { ...defaults },
      };
    }

    // --- Aggregation Logic ---
    const dailyMap = new Map();
    const hourlyEfficiency = [];
    const hourlyOrders = [];
    const hourlyLabels = [];
    const hourlyLabor = [];

    data.forEach(item => {
      const labor = (item.packers || 0) + (item.pickers || 0);
      const labels = item.labels || 0;
      const orders = item.orders || 0;

      hourlyOrders.push(orders);
      hourlyLabels.push(labels);
      hourlyLabor.push(labor);
      
      if (labor > 0) {
        hourlyEfficiency.push(labels / labor);
      }

      if (item.sortTime) {
        const dateObj = new Date(item.sortTime);
        const dateKey = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD

        if (!dailyMap.has(dateKey)) {
          dailyMap.set(dateKey, { orders: 0, labels: 0 });
        }
        const currentDay = dailyMap.get(dateKey);
        currentDay.orders += orders;
        currentDay.labels += labels;
        dailyMap.set(dateKey, currentDay);
      }
    });

    const dailyAggregates = Array.from(dailyMap.entries()).map(([date, counts]) => ({ date, ...counts }));

    // --- Peak Days ---
    let maxDailyOrders = { count: 0, date: 'N/A' };
    let maxDailyLabels = { count: 0, date: 'N/A' };

    const formatter = new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric' });

    dailyAggregates.forEach(day => {
      const [y, m, d] = day.date.split('-').map(Number);
      const dateObj = new Date(y, m - 1, d, 12);
      const formattedDate = formatter.format(dateObj);
      
      if (day.orders > maxDailyOrders.count) {
        maxDailyOrders = { count: day.orders, date: formattedDate };
      }
      if (day.labels > maxDailyLabels.count) {
        maxDailyLabels = { count: day.labels, date: formattedDate };
      }
    });

    const getStats = (arr) => {
        if (arr.length === 0) return { min: 0, max: 0, avg: 0 };
        const sum = arr.reduce((a, b) => a + b, 0);
        return {
            min: Math.min(...arr),
            max: Math.max(...arr),
            avg: sum / arr.length
        };
    };

    return {
      maxDailyOrders,
      maxDailyLabels,
      labelsPerLabor: getStats(hourlyEfficiency),
      ordersStats: getStats(hourlyOrders),
      labelsStats: getStats(hourlyLabels),
      laborStats: getStats(hourlyLabor),
    };
  }, [data]);

  return (
    <div className="mb-8">
        <div className="mb-4 text-center sm:text-left">
            <h2 className="text-2xl font-bold text-green-300">BFCM Aggregated Summary</h2>
            <p className="text-green-500">Highlights of peak performance and hourly operational metrics.</p>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            <SummaryCard
                title="Peak Orders (Max Day)"
                value={aggregates.maxDailyOrders.count.toLocaleString()}
                unit="Orders"
                description={`Highest volume day: ${aggregates.maxDailyOrders.date}`}
                colorClass="text-red-500"
            />
            <SummaryCard
                title="Peak Labels (Max Day)"
                value={aggregates.maxDailyLabels.count.toLocaleString()}
                unit="Labels"
                description={`Highest volume day: ${aggregates.maxDailyLabels.date}`}
                colorClass="text-blue-500"
            />
            <SummaryCard
                title="Labels per Labor Unit (Hourly)"
                value={aggregates.labelsPerLabor.avg.toFixed(1)}
                unit="Labels/Person"
                description={`Min: ${aggregates.labelsPerLabor.min.toFixed(1)} | Max: ${aggregates.labelsPerLabor.max.toFixed(1)} (Efficiency)`}
                colorClass="text-amber-500"
            />
            <SummaryCard
                title="Orders Hourly Volume"
                value={aggregates.ordersStats.avg.toFixed(0)}
                unit="Avg / Hr"
                description={`Min: ${aggregates.ordersStats.min} | Max: ${aggregates.ordersStats.max} orders per hour`}
                colorClass="text-red-400"
            />
            <SummaryCard
                title="Labels Hourly Volume"
                value={aggregates.labelsStats.avg.toFixed(0)}
                unit="Avg / Hr"
                description={`Min: ${aggregates.labelsStats.min} | Max: ${aggregates.labelsStats.max} labels per hour`}
                colorClass="text-blue-400"
            />
            <SummaryCard
                title="Total Labor Hourly Volume"
                value={aggregates.laborStats.avg.toFixed(0)}
                unit="Avg People"
                description={`Min: ${aggregates.laborStats.min} | Max: ${aggregates.laborStats.max} staff on duty`}
                colorClass="text-purple-400"
            />
        </div>
    </div>
  );
};

// --- Reusable Chart Component ---
const MetricsChart = ({ title, data, files, showXAxis = true }) => {
  const chartLines = useMemo(() => files.map(file => (
    <Line
      key={file.key}
      type="monotone"
      dataKey={file.key}
      name={file.name}
      stroke={COLORS[file.key]}
      strokeWidth={2}
      dot={false}
      activeDot={{ r: 5, stroke: COLORS[file.key], fill: COLORS[file.key] }}
    />
  )), [files]);

  return (
    <div className="mb-8 p-6 bg-gray-800 rounded-lg border border-green-700 shadow-[0_0_15px_rgba(52,211,153,0.4)]">
      <h3 className="text-xl font-semibold mb-4 text-green-300">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart
          data={data}
          syncId="bfcmMetrics"
          margin={{ top: 20, right: 30, left: 75, bottom: 50 }} 
          style={{ backgroundColor: '#1f2937' }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" strokeOpacity={0.5} />
          <XAxis 
            dataKey="hour" 
            hide={!showXAxis}
            height={showXAxis ? 70 : 0}
            angle={-45} 
            textAnchor="end" 
            stroke="#34d399"
            tick={{ fontSize: 10, fill: '#34d399' }}
          />
          <YAxis 
            label={{ value: 'Total Count', angle: -90, position: 'insideLeft', fill: '#34d399', dx: -55 }}
            tickFormatter={(value) => value.toLocaleString()}
            stroke="#34d399"
            tick={{ fill: '#34d399' }}
          />
          <Tooltip 
            cursor={{ strokeDasharray: '5 5', stroke: '#34d399' }}
            contentStyle={{ 
              borderRadius: '6px', 
              backgroundColor: 'rgba(31, 41, 55, 0.95)',
              border: '1px solid #34d399',
              padding: '10px'
            }}
            labelStyle={{ fontWeight: 'bold', color: '#34d399' }}
            formatter={(value, name) => [value.toLocaleString(), name]}
          />
          <Legend wrapperStyle={{ paddingTop: '20px', color: '#34d399' }} iconType="rect"/>
          {chartLines}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

// --- Main Component ---
const App = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedRangeDays, setSelectedRangeDays] = useState(7);

  const processAllFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetchPromises = ALL_CSV_FILES.map(file =>
        fetchWithRetry(file.url, file.name).then(csvText => ({ key: file.key, csvText }))
      );

      const results = await Promise.all(fetchPromises);
      const hourlyDataMap = new Map();

      results.forEach(({ key, csvText }) => {
        const parsedData = parseCSV(csvText);
        parsedData.forEach(item => {
          const dateObj = new Date(item.timestamp);
          if (!isNaN(dateObj)) {
            const { hour, sortTime } = getHourlyKey(item.timestamp);
            if (hour) {
              if (!hourlyDataMap.has(hour)) {
                hourlyDataMap.set(hour, { 
                    hour, 
                    sortTime, 
                    ...Object.fromEntries(ALL_CSV_FILES.map(f => [f.key, 0])) 
                });
              }
              const currentHour = hourlyDataMap.get(hour);
              currentHour[key] += item.value;
              hourlyDataMap.set(hour, currentHour);
            }
          }
        });
      });

      const finalChartData = Array.from(hourlyDataMap.values()).sort((a, b) => a.sortTime - b.sortTime);
      setData(finalChartData);

    } catch (err) {
      console.error("Data processing error:", err);
      setError(err.message || "An unknown error occurred while loading data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    processAllFiles();
  }, [processAllFiles]);

  const filteredData = useMemo(() => {
    if (data.length === 0) return [];
    const maxDate = data[data.length - 1].sortTime;
    const rangeInMs = selectedRangeDays * 24 * 60 * 60 * 1000;
    const minDate = maxDate - rangeInMs;
    return data.filter(item => item.sortTime >= minDate);
  }, [data, selectedRangeDays]);

  return (
    <div className="min-h-screen bg-gray-900 p-4 sm:p-8 font-mono text-green-400">
      <header className="text-center mb-8 border-b border-green-700 pb-4 relative">
        <div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-green-300">
            :: BFCM FULFILLMENT MONITOR ::
            </h1>
            <p className="text-lg text-green-500 mt-1">
            &gt; Analyzing core metrics by hour. Access granted.
            </p>
        </div>
        <div className="absolute top-0 right-0 hidden md:block">
            <button
            onClick={processAllFiles}
            disabled={loading}
            className="text-green-400 hover:text-cyan-400 transition-colors p-2"
            title="Refresh Data"
            >
            <RefreshCcw className={loading ? "animate-spin" : ""} size={24} />
            </button>
        </div>
      </header>
      
      {error && (
        <div className="bg-red-900/50 border border-red-500 p-4 mb-6 rounded text-red-200">
            <strong>Error:</strong> {error}
        </div>
      )}

      {loading && !data.length ? (
          <div className="text-center py-20 text-cyan-400">
            <Loader2 className="animate-spin inline-block mr-2" size={32} />
            <p>Loading and aggregating data stream...</p>
          </div>
      ) : (
        <>
            <TimeRangeSelector 
                selectedRange={selectedRangeDays} 
                onSelectRange={setSelectedRangeDays} 
            />

            <SummaryWidget data={filteredData} />

            <div className="space-y-6">
                <MetricsChart
                title="Group 1: ORDERS & SHIPPING LABELS Trend (Volume)"
                data={filteredData}
                files={GROUP_A_FILES}
                showXAxis={true}
                />

                <MetricsChart
                title="Group 2: PICKERS & PACKERS Labor Trend (Efficiency)"
                data={filteredData}
                files={GROUP_B_FILES}
                showXAxis={true}
                />
            </div>
        </>
      )}

      <footer className="text-center mt-8 text-sm text-green-600 border-t border-green-800 pt-4">
        DATA SOURCE: Shiphero Public Metrics | INTERFACE: React/Recharts/Tailwind (Terminal Mode)
      </footer>
    </div>
  );
};

export default App;
