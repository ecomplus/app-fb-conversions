const fbBizSdk = require('facebook-nodejs-business-sdk')

// read configured E-Com Plus app data
const getAppData = require('./../../lib/store-api/get-app-data')

const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'

exports.post = ({ appSdk }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body

  if (trigger.resource === 'orders' && trigger.action === 'create') {
    const order = trigger.body
    const buyer = order.buyers && order.buyers[0]
    if (buyer) {
      // get app configured options
      return getAppData({ appSdk, storeId })

        .then(appData => {
          if (
            Array.isArray(appData.ignore_triggers) &&
            appData.ignore_triggers.indexOf(trigger.resource) > -1
          ) {
            // ignore current trigger
            const err = new Error()
            err.name = SKIP_TRIGGER_NAME
            throw err
          }

          /* DO YOUR CUSTOM STUFF HERE */

          // https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api#send
          const fbPixelId = appData.fb_pixel_id
          const fbGraphToken = appData.fb_graph_token
          if (fbPixelId && fbGraphToken) {
            const Content = fbBizSdk.Content
            const CustomData = fbBizSdk.CustomData
            const DeliveryCategory = fbBizSdk.DeliveryCategory
            const EventRequest = fbBizSdk.EventRequest
            const UserData = fbBizSdk.UserData
            const ServerEvent = fbBizSdk.ServerEvent
            fbBizSdk.FacebookAdsApi.init(fbGraphToken)

            const userData = new UserData()
            const emails = buyer.emails || []
            if (buyer.main_email) {
              emails.push(buyer.main_email)
            }
            if (emails.length) {
              userData.setEmails(emails)
            }
            if (buyer.phones && buyer.phones.length) {
              userData.setPhones(buyer.phones.map(({ number }) => String(number)))
            }
            if (order.browser_ip) {
              userData.setClientIpAddress(order.browser_ip)
            }

            const contents = []
            const { items } = order
            if (items && items.length) {
              items.forEach(item => {
                if (item.quantity > 0) {
                  const content = (new Content())
                    .setId(item.sku || item.product_id)
                    .setQuantity(item.quantity)
                    .setDeliveryCategory(DeliveryCategory.HOME_DELIVERY)
                  if (item.name) {
                    content.setTitle(item.name)
                  }
                  contents.push(content)
                }
              })
            }
            const customData = (new CustomData())
              .setContents(contents)
              .setCurrency((order.currency_id && order.currency_id.toLowerCase()) || 'brl')
              .setValue(Math.round(order.amount.total * 100) / 100)

            const eventMs = Math.min(new Date(order.created_at || trigger.datetime).getTime(), Date.now() - 3000)
            console.log(`#${storeId} ${trigger.inserted_id} at ${eventMs}ms`)

            const serverEvent = (new ServerEvent())
              .setEventName('Purchase')
              .setEventTime(Math.round(eventMs / 1000))
              .setUserData(userData)
              .setCustomData(customData)
              .setActionSource('website')
            if (order.checkout_link) {
              serverEvent.setEventSourceUrl(order.checkout_link)
            } else if (order.domain) {
              serverEvent.setEventSourceUrl(`https://${order.domain}`)
            }

            const eventsData = [serverEvent]
            const eventRequest = (new EventRequest(fbGraphToken, fbPixelId))
              .setEvents(eventsData)

            eventRequest.execute().then(
              response => {
                // all done
                res.status(201).send(ECHO_SUCCESS)
              },
              err => {
                console.error(`Facebook event request error: ${err.message}`, err, JSON.stringify(trigger))
                res.sendStatus(202)
              }
            )
          }
        })

        .catch(err => {
          if (err.name === SKIP_TRIGGER_NAME) {
            // trigger ignored by app configuration
            res.send(ECHO_SKIP)
          } else if (err.appWithoutAuth === true) {
            const msg = `Webhook for ${storeId} unhandled with no authentication found`
            const error = new Error(msg)
            error.trigger = JSON.stringify(trigger)
            console.error(error)
            res.status(412).send(msg)
          } else {
            // console.error(err)
            // request to Store API with error response
            // return error status code
            res.status(500)
            const { message } = err
            res.send({
              error: ECHO_API_ERROR,
              message
            })
          }
        })
    }
  }

  res.sendStatus(412)
}
