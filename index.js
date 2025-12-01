const express = require('express')
const cors = require('cors')
const app = express()
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000;

//from firebase code //
const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8");
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


function generateTrackingId() {
  const prefix = "BD"; // or your company code
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase(); // random chars
  
  return `${prefix}-${datePart}-${randomPart}`;
}


// middlewire
app.use(cors())
app.use(express.json())

const verifyFBToken =async (req,res,next) => {
    const token = req.headers.authorization;
    console.log('headers in the middlewire',token);
    if(!token){
        return res.status(401).send({message: 'unauthorized access'})
    }
    try{
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        console.log('decoded in the token:',decoded);
        req.decoded_email = decoded.email;
        next();

    }
    catch(error){
        res.status(401).send({message: 'unauthorized access'})
    }
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.gafegcj.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db('zap_shift_db');
    const parcelCollection = db.collection('parcels');
    const paymentCollection = db.collection('payments');
    const userCollection = db.collection('users');
    const ridersCollection = db.collection('riders');
    const trackingCollection = db.collection('trackings');

    //???  middle wire with the database access for admin. Must be used after verifyFBToken middlewire  ???///
    const verifyAdmin = async(req,res,next) => {
        const email = req.decoded_email;
        const query = {email};
        const user = await userCollection.findOne(query);

        if(!user || user?.role !== 'admin'){
            return res.status(403).send({message: 'forbidden access'})
        }

        next();
    }

    // function for tracking log
    const logTracking = async(trackingId,status) => {
        const log = {
            trackingId, status, 
            details: status.split('_').join(' '),
            createdAt: new Date()
        }
        const result = await trackingCollection.insertOne(log);
        return result;
    }

    ////// user API //////
    app.get('/users', verifyFBToken,async(req,res) => {
        const searchText = req.query.searchText;
        const query =  {};
        if(searchText){
            // single class search
            // query.displayName = {$regex: searchText, $options: 'i'}

            // multiple class search
            query.$or = [
                // searching based on display name
                {displayName : {$regex: searchText, $options: 'i'}},
                {email : {$regex: searchText, $options: 'i'}}
                // searching based on 
            ]
        }
        const cursor = userCollection.find(query).sort({createdAt: -1});
        const result = await cursor.toArray();
        res.send(result)
    })

    // for role setup
    app.get('/users/:email/role', async(req,res)=> {
        const email = req.params.email;
        const query = {email};
        const user = await userCollection.findOne(query);
        res.send({role: user?.role || 'user'})
    })

    app.post('/users',async(req,res) => {
        const user = req.body;
        user.role = 'user';
        user.createdAt = new Date();

        const email = user.email;
        const userExists = await userCollection.findOne({email});
        if(userExists){
            return res.send({message: "social user exists"})
        }

        const result = await userCollection.insertOne(user);
        res.send(result)
    })

    app.patch('/users/:id/role',verifyFBToken,verifyAdmin,async(req,res)=> {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = {_id: new ObjectId(id)};
        const updatedDoc = {
            $set: {
                role : roleInfo.role
            }
        }
        const result = await userCollection.updateOne(query,updatedDoc);
        res.send(result)
    })
    
    //// parecel API //////
    app.post('/parcels',async(req,res)=> {
        const parcel = req.body;
        const trackingId = generateTrackingId();
        // adding the date when data add
        parcel.createdAt = new Date(); 
        parcel.trackingId = trackingId;
        const result = await parcelCollection.insertOne(parcel);
        logTracking(trackingId,'parcel_created')
        res.send(result)
    })

    app.get('/parcels',async(req,res)=> {
        const query = {};
        const {email,deliveryStatus} = req.query;
        if(email){
            query.senderEmail = email;
        }
        // for the parcel which delivery Status is pending-pickup
        if(deliveryStatus){
            query.deliveryStatus = deliveryStatus;
        }
        const sortCost = {sort : {createdAt: -1}}
        const cursor = parcelCollection.find(query,sortCost);
        const result = await cursor.toArray();
        res.send(result)
    })
    // for parcel to assign rider
    app.get('/parcels/rider', async(req,res) => {
        const {riderEmail,deliveryStatus} = req.query;
        const query = {};
        if(riderEmail){
            query.riderEmail = riderEmail;
        }
        if(deliveryStatus){
            // query.deliveryStatus = deliveryStatus;
            // query.deliveryStatus = {$in: ['rider_assigned','rider_arriving']};
            query.deliveryStatus = {$nin: ['parcel_delivered']};
        }

        const cursor = parcelCollection.find(query);
        const result = await cursor.toArray();
        res.send(result)
    })

    // for the completed delivery of a rider
    app.get('/parcels/riderCompleted', async(req,res) => {
        const {riderEmail,deliveryStatus} = req.query;
        const query = {};
        if(riderEmail){
            query.riderEmail = riderEmail;
        }
        if(deliveryStatus){
            query.deliveryStatus = deliveryStatus;
            // query.deliveryStatus = {$in: ['rider_assigned','rider_arriving']};
            // query.deliveryStatus = {$in: ['parcel_delivered']};
        }

        const cursor = parcelCollection.find(query);
        const result = await cursor.toArray();
        res.send(result)
    })

    app.get('/parcel/:id',async (req,res) => {
        const id = req.params.id;
        const query = {_id: new ObjectId(id)};
        const result = await parcelCollection.findOne(query);
        res.send(result)
    })
    // have to chnage the url like /parcel/:id/assign
    app.patch('/parcel/:id',async(req,res) => {
        // update parcel information
        const {riderId,riderEmail,riderName,trackingId} = req.body;
        const parcelId = req.params.id;
        const query = {_id: new ObjectId(parcelId)};
        const updatedDoc = {
            $set : {
                deliveryStatus: 'rider_assigned',
                riderId: riderId,
                riderEmail:riderEmail,
                riderName: riderName
            }
        }
        const result = await parcelCollection.updateOne(query,updatedDoc);

        // update rider information
        const riderQuery = {_id: new ObjectId(riderId)};
        const riderUpdatedDoc = {
            $set: {
                workStatus: 'in_delivery'
            }
        }
        const riderResult = await ridersCollection.updateOne(riderQuery,riderUpdatedDoc);
        // log tracking
        logTracking(trackingId,'rider_assigned')
        res.send(riderResult)
    })

    // 
    app.patch('/parcels/:id/status', async(req,res) => {
        const {deliveryStatus,riderId,trackingId} = req.body;
        const query = {_id: new ObjectId(req.params.id)};
        const updatedDoc = {
            $set: {deliveryStatus: deliveryStatus}
        }
        // update rider information
        if(deliveryStatus === 'parcel_delivered'){
            const riderQuery = {_id: new ObjectId(riderId)};
            const riderUpdatedDoc = {
                $set: {
                    workStatus: 'available'
                }
            }
            const riderResult = await ridersCollection.updateOne(riderQuery,riderUpdatedDoc);
        }
        const result = await parcelCollection.updateOne(query,updatedDoc)
        // log tracking
        logTracking(trackingId,deliveryStatus)
        res.send(result)
    })

    app.delete('/parcels/:id',async (req,res)=>{
        const id = req.params.id;
        const query = {_id : new ObjectId(id)};
        const result = await parcelCollection.deleteOne(query);
        res.send(result)
    })

    ///// PAYMENT API  /////

    app.post('/create-checkout-session', async (req, res) => {
        const paymentInfo = req.body;
        const amount = parseInt(paymentInfo.cost) * 100;
    const session = await stripe.checkout.sessions.create({
        line_items: [
        {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
                currency: 'USD',
                unit_amount: amount,
                product_data: {
                    name: paymentInfo.parcelName,
                }
            },
            quantity: 1,
        },
    ],
        customer_email: paymentInfo.senderEmail,
        mode: 'payment',
        metadata: {
            parcelId: paymentInfo.parcelId,
            parcelName: paymentInfo.parcelName,
            trackingId: paymentInfo.trackingId
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });
     console.log(session);
     res.send({url: session.url})
    // res.redirect(303, session.url);
    });

    app.patch('/payment-success',async (req,res)=> {
        const sessionId = req.query.session_id;

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        console.log("session:",session);

        const transactionId= session.payment_intent;
        const query = {transactionId: transactionId};

        const paymentExist = await paymentCollection.findOne(query);
        if(paymentExist){
            return res.send({message: 'already exist',transactionId,trackingId: paymentExist.trackingId})
        }

        // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
        // const trackingId = generateTrackingId();
        const trackingId = session.metadata.trackingId;

        if(session.payment_status === 'paid'){
            const parcel_id = session.metadata.parcelId;
            const query = {_id: new ObjectId(parcel_id)};
            const update = {
                $set: {
                    paymentStatus: 'paid',
                    deliveryStatus: 'pending-pickup',
                    // trackingId : trackingId
                }
            }
            const result = await parcelCollection.updateOne(query,update)

            const payment = {
                amount : session.amount_total/100,
                currency : session.currency,
                customerEmail: session.customer_email,
                parcelId : session.metadata.parcelId,
                parcelName: session.metadata.parcelName,
                transactionId: session.payment_intent,
                paymentStatus: session.payment_status,
                paidAt: new Date(),
                trackingId : trackingId
            }
            if(session.payment_status === 'paid'){
                const paymentResult = await paymentCollection.insertOne(payment);

                // log tracking
                logTracking(trackingId,'parcel_paid')
                res.send({success : true,modifyParcel: result,trackingId : trackingId,transactionId: session.payment_intent,paymentInfo: paymentResult,})
            }
            // res.send(result)
        }
        res.send({success : true})
    })

    // get payment history
    app.get('/payments',verifyFBToken, async(req,res)=> {
        const email = req.query.email;
        console.log("header:",req.headers)
        const query = {};
        if(email){
            query.customerEmail = email;
            // check email with the jws token email
            if(email !== req.decoded_email){
                return res.status(403).send({message: 'forbidden access'})
            }
        }
        const cursor = paymentCollection.find(query).sort({paidAt: -1});
        const result = await cursor.toArray();
        res.send(result)
    })

    ///// Rider API /////
    app.post('/riders',async(req,res)=> {
        const rider = req.body;
        rider.status = 'pending';
        rider.createdAt = new Date();
        const result = await ridersCollection.insertOne(rider);
        res.send(result)
    })

    app.get('/riders',async(req,res)=> {
        const {status,district,workStatus} = req.query;
        const query = {};
        if(status){
            query.status = status;
        }
        if(district){
            query.district = district;
        }
        if(workStatus){
            query.workStatus = workStatus;
        }
        const cursor =  ridersCollection.find(query);
        const result = await cursor.toArray();
        res.send(result)
    })

    app.patch('/riders/:id',verifyFBToken,verifyAdmin,async (req,res) => {
        const status = req.body.status;
        const id = req.params.id;
        const query = {_id: new ObjectId(id)}
        const updateInfo = {
            $set: {
                status: status,
                workStatus: 'available'
            }
        }
        const result =await ridersCollection.updateOne(query,updateInfo);

        if(status === 'approve'){
            const email = req.body.email;
            const userQuery = {email};
            const updateRole = {
                $set: {
                    role: 'rider'
                }
            }
            const result = await userCollection.updateOne(userQuery,updateRole)
        }
        res.send(result)
    })

    ////// Tracking related ApI
    app.get('/trackings/:trackingId/logs',async(req,res) => {
        const trackingId =  req.params.trackingId;
        const query = {trackingId};
        const result = await trackingCollection.find(query).toArray();
        res.send(result);
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
