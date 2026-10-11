// Public daily-quota protocol values. The authority implementation is deployed separately.
export const DIY_DAILY_EXPORTS=10
export const beijingDay=timestamp=>new Date(timestamp+8*3600_000).toISOString().slice(0,10)
export const quotaDayEnd=day=>Date.parse(day+'T00:00:00+08:00')+86400000
export const isQuotaId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
