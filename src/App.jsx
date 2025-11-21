import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';

// --- Configuration ---
const PROXY_BASE = 'https://corsproxy.io/?url=';
const DATA_BASE = 'https://bfcm-2025-data-viz.shiphero.com/sh_metrics/metrics/';

// Retry configuration for resilient fetching
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

const TIME_RANGES = [
  { label: 'LAST 24 HOURS', days: 1 },
  { label: 'LAST 3 DAYS', days: 3 },
  { label: 'LAST 7 DAYS', days: 7 },
  { label: 'LAST 2 WEEKS', days: 14 },
  { label: 'LAST 4 WEEKS', days: 28 },
];

/**
 * Constructs the final, encoded URL for the CORS proxy.
 * @param {string} path - The specific CSV filename (e.g., 'orders.csv').
 * @returns {string} The full proxied URL.
 */
const getProxyUrl = (path) => {
  const targetUrl = DATA_BASE + path;
  return `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
};

// Define all files - SHIPPINGS_BY_COUNTRY.CSV HAS BEEN EXCLUDED
const ALL_CSV_FILES = [
  { url: getProxyUrl('orders.csv'), key: 'orders', name: 'Orders' },
  { url: getProxyUrl('shipping_labels.csv'), key: 'labels', name: 'Shipping Labels' },
  // Excluded: shippings_by_country.csv
  { url: getProxyUrl('total_packers.csv'), key: 'packers', name: 'Total Packers' },
  { url: getProxyUrl('total_pickers.csv'), key: 'pickers', name: 'Total Pickers' },
];

// Split files into two groups for separate charts
const GROUP_A_FILES = ALL_CSV_FILES.slice(0, 2); // Orders, Labels
const GROUP_B_FILES = ALL_CSV_FILES.slice(2);     // Packers, Pickers

// Define colors for the lines (kept bright for contrast on dark background)
const COLORS = {
  orders: '#f87171',     // Light Red (brighter than #ef4444)
  labels: '#60a5fa',     // Light Blue (brighter than #3b82f6)
  packers: '#fbbf24',    // Amber
  pickers: '#a78bfa',    // Violet
};

// --- Utility Functions ---

/**
 * A simple CSV parser.
 */
const parseCSV = (csvText) => {
  if (!csvText) return [];
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  return lines.slice(1).map(line => {
    const parts = line.split(','); 
    if (parts.length < 2) return { timestamp: '', value: 0 };
    
    const timestampStr = parts[0];
    const valueStr = parts[1];
    
    const timestamp = timestampStr.replace(/"/g, '').trim();
    const value = parseInt(valueStr.replace(/"/g, '').trim(), 10);
    return { timestamp, value: isNaN(value) ? 0 : value };
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

  return `${monthName}-${day} ${hour}:00`;
};

// Function with exponential backoff for retries
const fetchWithRetry = async (url, name, retries = MAX_RETRIES) => {
    let delay = INITIAL_DELAY_MS;
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                // If the proxy returns an error, throw to trigger retry
                throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
            }
            return await res.text();
        } catch (error) {
            console.warn(`Fetch attempt ${i + 1} for ${name} failed: ${error.message}. Retrying in ${delay / 1000}s...`);
            if (i === retries - 1) {
                throw new Error(`Failed to fetch ${name} after ${MAX_RETRIES} attempts.`);
            }
            // Exponential backoff
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
  // Terminal Style: Dark background, bright border, subtle glow
  <div className="bg-gray-800 p-5 rounded-lg border border-green-700 shadow-[0_0_10px_rgba(52,211,153,0.3)] h-full">
    <p className="text-sm font-medium text-green-400">{title}</p>
    <div className="text-2xl sm:text-3xl font-bold text-cyan-400 my-1">
      {value} <span className="text-lg font-semibold text-green-500">{unit}</span>
    </div>
    <p className="text-xs text-green-600 mt-2 leading-relaxed">{description}</p>
  </div>
);

const SummaryWidget = ({ data }) => {
  // Use useMemo to calculate aggregate statistics only when data changes
  const aggregates = useMemo(() => {
    const defaults = { 
        count: 0, min: 0, max: 0, avg: 0
    };
    
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

    // --- Daily Aggregation Setup ---
    const dailyMap = new Map();
    
    // Arrays to store hourly metrics
    const hourlyEfficiency = [];
    const hourlyOrders = [];
    const hourlyLabels = [];
    const hourlyLabor = [];

    data.forEach(item => {
      const labor = (item.packers || 0) + (item.pickers || 0);
      const labels = item.labels || 0;
      const orders = item.orders || 0;

      // --- Collect Hourly Data ---
      hourlyOrders.push(orders);
      hourlyLabels.push(labels);
      hourlyLabor.push(labor);
      
      // Avoid division by zero for efficiency
      if (labor > 0) {
        hourlyEfficiency.push(labels / labor);
      }

      // --- Daily Aggregation Logic ---
      // Use sortTime (numeric timestamp) to reliably determine the day
      if (item.sortTime) {
        const dateObj = new Date(item.sortTime);
        // Create a key YYYY-MM-DD
        const dateKey = dateObj.toISOString().split('T')[0];

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

    // --- Max Daily Calculations ---
    let maxDailyOrders = { count: 0, date: 'N/A', dayName: 'N/A' };
    let maxDailyLabels = { count: 0, date: 'N/A', dayName: 'N/A' };

    const formatter = new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric' });

    dailyAggregates.forEach(day => {
      const [y, m, d] = day.date.split('-').map(Number);
      const dateObj = new Date(y, m - 1, d);
      const formattedDate = formatter.format(dateObj);
      
      if (day.orders > maxDailyOrders.count) {
        maxDailyOrders = { count: day.orders, date: formattedDate };
      }
      if (day.labels > maxDailyLabels.count) {
        maxDailyLabels = { count: day.labels, date: formattedDate };
      }
    });

    // --- Helper to calculate stats ---
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
        <div className="mb-4">
            <h2 className="text-2xl font-bold text-green-300">BFCM Aggregated Summary</h2>
            <p className="text-green-500">Highlights of peak performance and hourly operational metrics.</p>
        </div>
        
        {/* Grid for metrics cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            
            {/* 1. Peak Orders (Max Day) */}
            <SummaryCard
                title="Peak Orders (Max Day)"
                value={aggregates.maxDailyOrders.count.toLocaleString()}
                unit="Orders"
                description={`Highest volume day: ${aggregates.maxDailyOrders.date}`}
                colorClass="text-red-500"
            />
            
            {/* 2. Peak Labels (Max Day) */}
            <SummaryCard
                title="Peak Labels (Max Day)"
                value={aggregates.maxDailyLabels.count.toLocaleString()}
                unit="Labels"
                description={`Highest volume day: ${aggregates.maxDailyLabels.date}`}
                colorClass="text-blue-500"
            />
            
            {/* 3. Efficiency: Labels per Labor Unit */}
            <SummaryCard
                title="Labels per Labor Unit (Hourly)"
                value={aggregates.labelsPerLabor.avg.toFixed(1)}
                unit="Labels/Person"
                description={`Min: ${aggregates.labelsPerLabor.min.toFixed(1)} | Max: ${aggregates.labelsPerLabor.max.toFixed(1)} (Efficiency)`}
                colorClass="text-amber-500"
            />

            {/* 4. Orders Hourly Volume */}
            <SummaryCard
                title="Orders Hourly Volume"
                value={aggregates.ordersStats.avg.toFixed(0)}
                unit="Avg / Hr"
                description={`Min: ${aggregates.ordersStats.min} | Max: ${aggregates.ordersStats.max} orders per hour`}
                colorClass="text-red-400"
            />

            {/* 5. Labels Hourly Volume */}
            <SummaryCard
                title="Labels Hourly Volume"
                value={aggregates.labelsStats.avg.toFixed(0)}
                unit="Avg / Hr"
                description={`Min: ${aggregates.labelsStats.min} | Max: ${aggregates.labelsStats.max} labels per hour`}
                colorClass="text-blue-400"
            />

            {/* 6. Total Labor Hourly Volume */}
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
  
  // Dynamic lines for the recharts component based on the files array passed in
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
    // Terminal Style: Dark background, bright border, subtle glow
    <div className="mb-8 p-6 bg-gray-800 rounded-lg border border-green-700 shadow-[0_0_15px_rgba(52,211,153,0.4)]">
      <h3 className="text-xl font-semibold mb-4 text-green-300">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart
          data={data}
          // Enables synchronization between all charts sharing this ID
          syncId="bfcmMetrics"
          // Adjusted margins to prevent axis label overlap
          margin={{ top: 20, right: 30, left: 75, bottom: 50 }} 
          style={{ backgroundColor: '#1f2937' }} // Dark chart background
        >
          {/* Darker grid lines for contrast */}
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" strokeOpacity={0.5} />
          
          {/* X-Axis: Always render to define dataKey for Tooltip, but visually hide if showXAxis is false. */}
          <XAxis 
            dataKey="hour" 
            hide={!showXAxis} // Visually hide
            height={showXAxis ? 70 : 0} // Remove height reservation if hidden
            angle={-45} 
            textAnchor="end" 
            stroke="#34d399" // Green stroke for axis line
            tick={{ fontSize: 10, fill: '#34d399' }} // Green tick text
          />
          
          {/* Y-Axis: Text in green-400 */}
          <YAxis 
            // Moved dx to -50 to push label further left avoiding overlap with ticks
            label={{ value: 'Total Count', angle: -90, position: 'insideLeft', fill: '#34d399', dx: -55 }}
            tickFormatter={(value) => value.toLocaleString()}
            stroke="#34d399" // Green stroke for axis line
            tick={{ fill: '#34d399' }} // Green tick text
          />

          {/* Tooltip: Dark background, light text */}
          <Tooltip 
            cursor={{ strokeDasharray: '5 5', stroke: '#34d399' }} // Neon green cursor
            contentStyle={{ 
              borderRadius: '6px', 
              backgroundColor: 'rgba(31, 41, 55, 0.95)', // Very dark opaque background
              border: '1px solid #34d399', // Green border
              padding: '10px'
            }}
            labelStyle={{ fontWeight: 'bold', color: '#34d399' }} // Neon green label
            // Formatter shows: 'Metric Name: Value'
            formatter={(value, name, props) => [
                value.toLocaleString(),
                props.name
            ]}
          />
          
          <Legend 
            // Increased top padding to 20px to separate from X-axis labels
            wrapperStyle={{ paddingTop: '20px', color: '#34d399' }} 
            iconType="rect"
          />
          
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
  // State for time filtering (default 7 days)
  const [selectedRangeDays, setSelectedRangeDays] = useState(7);


  /**
   * Fetches all CSV files and aggregates the data hourly.
   */
  const processAllFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Fetch all files concurrently using the retry logic
      const fetchPromises = ALL_CSV_FILES.map(file =>
        fetchWithRetry(file.url, file.name)
          .then(csvText => ({ key: file.key, csvText }))
      );

      const results = await Promise.all(fetchPromises);

      // 2. Aggregate data into a map keyed by the hourly timestamp
      // Map structure: { 'Oct-21 13:00': { hour: 'Oct-21 13:00', sortTime: 1234567890, orders: 10, ... } }
      const hourlyDataMap = new Map();

      results.forEach(({ key, csvText }) => {
        const parsedData = parseCSV(csvText);

        parsedData.forEach(item => {
          // Calculate date object and sortTime (numeric timestamp) for sorting
          const dateObj = new Date(item.timestamp);
          if (!isNaN(dateObj)) {
            dateObj.setMinutes(0, 0, 0, 0);
            const sortTime = dateObj.getTime();
            const hourlyKey = getHourlyKey(item.timestamp); // e.g., "Oct-21 13:00"

            if (hourlyKey) {
              if (!hourlyDataMap.has(hourlyKey)) {
                // Initialize the object for this hour
                hourlyDataMap.set(hourlyKey, { 
                    hour: hourlyKey, 
                    sortTime: sortTime, // Store numeric timestamp for robust sorting/filtering
                    ...Object.fromEntries(ALL_CSV_FILES.map(f => [f.key, 0])) 
                });
              }

              // Add the metric value to the corresponding hour and key
              const currentHour = hourlyDataMap.get(hourlyKey);
              currentHour[key] += item.value;
              hourlyDataMap.set(hourlyKey, currentHour);
            }
          }
        });
      });

      // 3. Convert the map values to a sorted array for the chart using the numeric sortTime
      const finalChartData = Array.from(hourlyDataMap.values()).sort((a, b) => {
        return a.sortTime - b.sortTime;
      });

      setData(finalChartData);

    } catch (err) {
      console.error("Data processing error:", err);
      setError(err.message || "An unknown error occurred while loading data.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch data on component mount
  useEffect(() => {
    processAllFiles();
  }, [processAllFiles]);

  // --- Time Filtering Logic ---
  const filteredData = useMemo(() => {
    if (data.length === 0) return [];

    // Find the maximum date in the dataset to calculate relative ranges
    // This handles historical data correctly (instead of using Date.now())
    const maxDate = data[data.length - 1].sortTime;
    const rangeInMs = selectedRangeDays * 24 * 60 * 60 * 1000;
    const minDate = maxDate - rangeInMs;

    return data.filter(item => item.sortTime >= minDate);
  }, [data, selectedRangeDays]);


  // --- Render Logic ---

  if (loading) {
    return (
      // Terminal Loading Screen
      <div className="flex items-center justify-center h-screen bg-gray-900 font-mono text-green-400">
        <div className="flex flex-col items-center p-8 bg-gray-800 rounded-xl border border-green-700 shadow-[0_0_15px_rgba(52,211,153,0.4)]">
          <svg className="animate-spin h-8 w-8 text-cyan-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="mt-4 text-green-400 font-medium animate-pulse">INITIATING DATA FEED... Aggregating BFCM metrics.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      // Terminal Error Screen
      <div className="p-8 h-screen bg-gray-900 font-mono text-red-400 flex items-center justify-center">
        <div className="p-6 bg-gray-800 border border-red-700 rounded-xl shadow-[0_0_15px_rgba(248,113,113,0.4)]">
          <h2 className="text-xl font-bold text-red-400 mb-2">ERROR: FAILED TO ESTABLISH CONNECTION</h2>
          <p className="text-red-500">The remote data endpoint or CORS proxy failed to respond. This is a common network-level restriction.</p>
          <p className="text-sm italic mt-2 text-red-600">Traceback: {error}</p>
          <button
            onClick={processAllFiles}
            className="mt-4 px-4 py-2 bg-red-700 text-white font-semibold rounded-lg hover:bg-red-600 transition duration-150 shadow-md border border-red-400"
          >
            RETRY_FETCH()
          </button>
        </div>
      </div>
    );
  }

  return (
    // Main Terminal View
    <div className="min-h-screen bg-gray-900 p-4 sm:p-8 font-mono text-green-400">
      <header className="text-center mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-green-300">
          :: BFCM FULFILLMENT MONITOR ::
        </h1>
        <p className="text-lg text-green-500 mt-1">
          &gt; Analyzing core metrics by hour. Access granted.
        </p>
      </header>
      
      {/* Time Range Selector */}
      <TimeRangeSelector 
        selectedRange={selectedRangeDays} 
        onSelectRange={setSelectedRangeDays} 
      />

      {/* Summary Widget (Uses filtered data) */}
      <SummaryWidget data={filteredData} />

      <div className="space-y-6">
        {/* Graph 1: Orders and Shipping Labels (Uses filtered data) */}
        <MetricsChart
          title="Group 1: ORDERS & SHIPPING LABELS Trend (Volume)"
          data={filteredData}
          files={GROUP_A_FILES}
          showXAxis={true} // Enabled X-Axis for top graph
        />

        {/* Graph 2: Packers and Pickers (Uses filtered data) */}
        <MetricsChart
          title="Group 2: PICKERS & PACKERS Labor Trend (Efficiency)"
          data={filteredData}
          files={GROUP_B_FILES}
          showXAxis={true} // Show X-axis on the bottom chart
        />
      </div>

      <footer className="text-center mt-8 text-sm text-green-600">
        DATA SOURCE: Shiphero Public Metrics | INTERFACE: React/Recharts/Tailwind (Terminal Mode)
      </footer>
    </div>
  );
};

export default App;
