import React, { useEffect, useState } from 'react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  Cell
} from 'recharts';
import { 
  Database, 
  FileAudio, 
  FileVideo, 
  FolderOpen, 
  TrendingUp,
  HardDrive
} from 'lucide-react';
import { motion } from 'motion/react';
import { apiFetch } from '../services/apiClient';

interface Stats {
  totalCases: number;
  totalRecordings: number;
  totalSize: number;
  mimeTypes: { mime_type: string; count: number }[];
  recentActivity: { date: string; count: number }[];
}

export const StatsView: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/stats')
      .then(data => {
        setStats(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Stats fetch failed:", err);
        setLoading(false);
      });
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-48">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500" />
    </div>
  );

  if (!stats) return null;

  const formatSize = (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
  };

  const videoCount = stats.mimeTypes.filter(m => m.mime_type.startsWith('video')).reduce((acc, curr) => acc + curr.count, 0);
  const audioCount = stats.mimeTypes.filter(m => m.mime_type.startsWith('audio')).reduce((acc, curr) => acc + curr.count, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white/5 border border-white/5 rounded-2xl p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 bg-orange-500/10 rounded-lg flex items-center justify-center">
              <FolderOpen size={16} className="text-orange-500" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Total Cases</span>
          </div>
          <p className="text-2xl font-bold">{stats.totalCases}</p>
        </div>

        <div className="bg-white/5 border border-white/5 rounded-2xl p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 bg-blue-500/10 rounded-lg flex items-center justify-center">
              <Database size={16} className="text-blue-500" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Recordings</span>
          </div>
          <p className="text-2xl font-bold">{stats.totalRecordings}</p>
        </div>

        <div className="bg-white/5 border border-white/5 rounded-2xl p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 bg-green-500/10 rounded-lg flex items-center justify-center">
              <HardDrive size={16} className="text-green-500" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Storage Used</span>
          </div>
          <p className="text-2xl font-bold">{formatSize(stats.totalSize)}</p>
        </div>

        <div className="bg-white/5 border border-white/5 rounded-2xl p-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 bg-purple-500/10 rounded-lg flex items-center justify-center">
              <TrendingUp size={16} className="text-purple-500" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Avg. Per Case</span>
          </div>
          <p className="text-2xl font-bold">{(stats.totalRecordings / (stats.totalCases || 1)).toFixed(1)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white/5 border border-white/5 rounded-2xl p-6">
          <h4 className="text-xs font-bold uppercase tracking-widest text-white/40 mb-6">Recent Activity (Last 7 Days)</h4>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.recentActivity}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis 
                  dataKey="date" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                  tickFormatter={(val) => val.split('-').slice(1).join('/')}
                />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#16191E', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                  itemStyle={{ color: '#fff' }}
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {stats.recentActivity.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={index === stats.recentActivity.length - 1 ? '#F97316' : '#F9731640'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white/5 border border-white/5 rounded-2xl p-6">
          <h4 className="text-xs font-bold uppercase tracking-widest text-white/40 mb-6">Media Distribution</h4>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-500/10 rounded-xl flex items-center justify-center">
                  <FileAudio size={20} className="text-orange-500" />
                </div>
                <div>
                  <p className="text-sm font-bold">Audio Files</p>
                  <p className="text-[10px] text-white/40">MP3, WAV, M4A</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold">{audioCount}</p>
                <p className="text-[10px] text-green-500 font-bold uppercase">{(audioCount / (stats.totalRecordings || 1) * 100).toFixed(0)}%</p>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
                  <FileVideo size={20} className="text-blue-500" />
                </div>
                <div>
                  <p className="text-sm font-bold">Video Files</p>
                  <p className="text-[10px] text-white/40">MP4, MOV, MPG</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold">{videoCount}</p>
                <p className="text-[10px] text-blue-500 font-bold uppercase">{(videoCount / (stats.totalRecordings || 1) * 100).toFixed(0)}%</p>
              </div>
            </div>

            <div className="pt-4 border-t border-white/5">
              <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest text-white/20 mb-2">
                <span>Storage Utilization</span>
                <span>{((stats.totalSize / (1024 * 1024 * 1024 * 10)) * 100).toFixed(1)}% of 10GB</span>
              </div>
              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, (stats.totalSize / (1024 * 1024 * 1024 * 10)) * 100)}%` }}
                  className="h-full bg-gradient-to-r from-orange-500 to-blue-500"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
