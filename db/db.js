import mongoose from 'mongoose';

mongoose.set('strictQuery', false);

const MAX_RETRIES = 5;

const connectDB = async (retryCount = 0) => {
  try {
    console.log('Connecting to MongoDB...');
    
    const isProduction = process.env.NODE_ENV === 'production';
    const timeouts = process.env.NODE_ENV === 'production' ? {
      serverSelectionTimeoutMS: 60000,
      connectTimeoutMS: 60000,
      socketTimeoutMS: 60000
    } : {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 10000
    };
    
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      ...timeouts,
      maxPoolSize: 10,
      minPoolSize: 2,
      retryWrites: true,
      w: 'majority',
      heartbeatFrequencyMS: 10000,
      maxIdleTimeMS: 30000
    });
    
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    
    // Ensure connection is ready
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Connection not ready');
    }
    
    return conn;
  } catch (err) {
    console.error(' MongoDB connection failed:', err.message);

    if (process.env.NODE_ENV === 'production') {
      if (retryCount >= MAX_RETRIES) {
        console.error(`❌ MongoDB connection failed after ${MAX_RETRIES} retries. Giving up.`);
        throw err;
      }
      console.log(`🔄 Retrying connection in 10 seconds... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, 10000));
      return connectDB(retryCount + 1); // Retry
    }

    throw err;
  }
};

export default connectDB;